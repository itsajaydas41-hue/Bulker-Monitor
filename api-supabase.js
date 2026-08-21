/* ================================================================
 * MAIDA BULKER FMS — Supabase browser backend
 * Three-file Vercel/GitHub edition
 * ================================================================ */
(function () {
  "use strict";

  var BUILD = "20260821-10";
  var TABLES = ["vehicle_master", "orders", "schedules", "trips", "stage_events", "stage_targets"];
  var DOCUMENT_BUCKET = "bulker-documents";
  var STAGES = ["ORDER", "SCHEDULE", "GATE_ENTRY", "EMPTY_WEIGHMENT", "LOADING_START", "LOADING_COMPLETE", "LOADED_WEIGHMENT", "DOCUMENTATION", "GATE_OUT", "PARTY_STORE", "POD"];
  var TARGETS = {
    GATE_ENTRY: ["Schedule → Gate Entry", 0, 3],
    EMPTY_WEIGHMENT: ["Gate Entry → Empty Weighment", 10, 4],
    LOADING_START: ["Empty Weighment → Loading Start", 10, 5],
    LOADING_COMPLETE: ["Loading Start → Loading Complete", 360, 6],
    LOADED_WEIGHMENT: ["Loading Complete → Loaded Weighment", 10, 7],
    DOCUMENTATION: ["Loaded Weighment → Documentation", 10, 8],
    GATE_OUT: ["Documentation → Gate Out", 10, 9],
    PARTY_STORE: ["Gate Out → Party Store", 1410, 10],
    POD: ["Party Store → POD", 30, 11]
  };
  var TOKEN_KEY = "maida_bulker_fms_access_token";
  var REFRESH_KEY = "maida_bulker_fms_refresh_token";

  // FIX: crypto.randomUUID() throws on non-HTTPS / non-localhost origins (insecure
  // context). If that throw happens inside createOrder/addVehicle/createSchedule/
  // completeStage, the whole async function rejects before any fetch is made, so
  // clicking "Generate order" can appear to do nothing. uuid() falls back safely.
  function uuid() {
    if (window.crypto && typeof crypto.randomUUID === "function") {
      try { return crypto.randomUUID(); } catch (e) { /* fall through to fallback */ }
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0, v = c === "x" ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  function base() { return String(window.SUPABASE_URL || "").replace(/\/+$/, ""); }
  function anon() { return String(window.SUPABASE_KEY || ""); }
  function token() { return sessionStorage.getItem(TOKEN_KEY) || anon(); }
  function configured() {
    return /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(base()) && anon() && !/YOUR-/i.test(anon());
  }
  // FIX: Supabase access tokens (JWT) expire (default ~1hr). Previously the app kept
  // reusing the stale token forever, so every action failed with "401 JWT expired"
  // until a manual page reload. This exchanges the stored refresh_token for a new
  // access_token transparently.
  var refreshing = null;
  async function refreshSession() {
    if (refreshing) return refreshing;
    var rt = sessionStorage.getItem(REFRESH_KEY);
    if (!rt) return false;
    refreshing = (async function () {
      try {
        var response = await fetch(base() + "/auth/v1/token?grant_type=refresh_token", {
          method: "POST", headers: { apikey: anon(), "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: rt })
        });
        var result = await response.json().catch(function () { return {}; });
        if (!response.ok || !result.access_token) return false;
        sessionStorage.setItem(TOKEN_KEY, result.access_token);
        if (result.refresh_token) sessionStorage.setItem(REFRESH_KEY, result.refresh_token);
        return true;
      } catch (e) {
        return false;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }
  function headers(prefer) {
    var h = { apikey: anon(), Authorization: "Bearer " + token(), "Content-Type": "application/json" };
    if (prefer) h.Prefer = prefer;
    return h;
  }
  function endpoint(table, query) { return base() + "/rest/v1/" + table + (query || ""); }
  async function request(table, query, options, _retried) {
    if (TABLES.indexOf(table) < 0) throw new Error("Unknown FMS table: " + table);
    options = options || {};
    var prefer = options.prefer;
    var fetchOpts = Object.assign({}, options);
    fetchOpts.headers = Object.assign(headers(prefer), options.headers || {});
    delete fetchOpts.prefer;
    var response;
    try {
      response = await fetch(endpoint(table, query), fetchOpts);
    } catch (networkErr) {
      // FIX: fetch() itself can throw (CORS block, bad SUPABASE_URL, offline, etc.)
      // Previously this bubbled up as a generic "Failed to fetch" — now it's explicit.
      console.error("Supabase network error on " + table, networkErr);
      throw new Error("Network error reaching Supabase — check SUPABASE_URL in config.js and your connection.");
    }
    if (!response.ok) {
      var body = await response.text().catch(function () { return ""; });
      if (response.status === 401 && !_retried && /jwt expired|pgrst303/i.test(body)) {
        var refreshed = await refreshSession();
        if (refreshed) return request(table, query, options, true);
        signOut();
        throw new Error("Your session has expired. Please sign in again.");
      }
      console.error("Supabase " + response.status + " on " + table, body);
      throw new Error("Supabase " + response.status + ": " + (body || response.statusText));
    }
    if (response.status === 204) return null;
    var text = await response.text();
    return text ? JSON.parse(text) : null;
  }
  function safeFileName(name) {
    return String(name || "document").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "document";
  }
  async function uploadDocument(file, trip, kind, _retried) {
    if (!file || typeof file.size !== "number") throw new Error("Select the " + kind + " PDF or image.");
    if (file.size > 10 * 1024 * 1024) throw new Error(kind + " file must be 10 MB or smaller.");
    var validType = /^(application\/pdf|image\/(jpeg|png|webp))$/i.test(file.type || "") || /\.(pdf|jpe?g|png|webp)$/i.test(file.name || "");
    if (!validType) throw new Error(kind + " file must be PDF, JPG, PNG, or WEBP.");
    var path = String(trip.id) + "/" + String(kind).toLowerCase() + "-" + Date.now() + "-" + safeFileName(file.name);
    if (!configured()) return path;
    var encodedPath = path.split("/").map(encodeURIComponent).join("/");
    var response;
    try {
      response = await fetch(base() + "/storage/v1/object/" + encodeURIComponent(DOCUMENT_BUCKET) + "/" + encodedPath, {
        method: "POST",
        headers: { apikey: anon(), Authorization: "Bearer " + token(), "Content-Type": file.type || "application/octet-stream", "x-upsert": "true" },
        body: file
      });
    } catch (networkErr) {
      throw new Error("Document upload could not reach Supabase. Check your connection and try again.");
    }
    if (!response.ok) {
      var body = await response.text().catch(function () { return ""; });
      if (response.status === 401 && !_retried && /jwt expired|pgrst303/i.test(body)) {
        var refreshed = await refreshSession();
        if (refreshed) return uploadDocument(file, trip, kind, true);
        signOut();
        throw new Error("Your session has expired. Please sign in again.");
      }
      throw new Error("Supabase document upload " + response.status + ": " + (body || response.statusText));
    }
    return path;
  }
  function one(rows) { return Array.isArray(rows) ? rows[0] : rows; }
  function iso(value) { return new Date(value || Date.now()).toISOString(); }
  function minutes(a, b) { return Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000)); }
  function addMinutes(value, count) { return new Date(new Date(value).getTime() + count * 60000).toISOString(); }
  function nextStage(current) { var i = STAGES.indexOf(current); return i >= 0 && i < STAGES.length - 1 ? STAGES[i + 1] : null; }
  function previousActual(trip, stage) {
    return {
      GATE_ENTRY: trip.created_at,
      EMPTY_WEIGHMENT: trip.actual_gate_entry,
      LOADING_START: trip.actual_empty_weighment,
      LOADING_COMPLETE: trip.actual_loading_start,
      LOADED_WEIGHMENT: trip.actual_loading_complete,
      DOCUMENTATION: trip.actual_loaded_weighment,
      GATE_OUT: trip.actual_documentation,
      PARTY_STORE: trip.actual_gate_out,
      POD: trip.actual_party_store
    }[stage];
  }
  function actualField(stage) {
    return {
      GATE_ENTRY: "actual_gate_entry", EMPTY_WEIGHMENT: "actual_empty_weighment",
      LOADING_START: "actual_loading_start", LOADING_COMPLETE: "actual_loading_complete",
      LOADED_WEIGHMENT: "actual_loaded_weighment", DOCUMENTATION: "actual_documentation",
      GATE_OUT: "actual_gate_out", PARTY_STORE: "actual_party_store", POD: "actual_pod"
    }[stage];
  }
  function statusFor(stage) {
    return { LOADING_START: "Loading", GATE_OUT: "Dispatched", PARTY_STORE: "At Party", POD: "Completed" }[stage] || "Waiting";
  }
  function mirror() {
    var url = String(window.GOOGLE_MIRROR_URL || "").trim();
    if (!url) return;
    fetch(url, { method: "POST", mode: "no-cors", body: JSON.stringify({ action: "sync", source: "maida-bulker-fms" }) }).catch(function () {});
  }

  var demo = (function () {
    var now = Date.now(), ago = function (m) { return new Date(now - m * 60000).toISOString(); };
    return {
      vehicles: [
        { id: "v1", vehicle_code: "Veh1", vehicle_number: "AS01SC-6927", active: true, status: "Loading", last_pod_at: null, next_available_at: null },
        { id: "v2", vehicle_code: "Veh2", vehicle_number: "AS01QC-6569", active: true, status: "At Party", last_pod_at: null, next_available_at: null }
      ],
      orders: [
        { id: "o1", order_no: "ORD-0001", order_date: new Date().toISOString().slice(0,10), party_name: "Britannia", item_name: "Refined Wheat Flour(Tanker)", order_qty: 500, scheduled_qty: 500, delivered_qty: 0, status: "Open", created_at: ago(180) },
        { id: "o2", order_no: "ORD-0002", order_date: new Date().toISOString().slice(0,10), party_name: "Britannia", item_name: "Refined Wheat Flour(Tanker)", order_qty: 500, scheduled_qty: 500, delivered_qty: 0, status: "Open", created_at: ago(350) }
      ],
      schedules: [
        { id: "s1", schedule_no: "SD-0001", order_id: "o1", vehicle_id: "v1", planned_gate_entry: ago(120), planned_qty: 500, status: "In Progress", created_at: ago(170) },
        { id: "s2", schedule_no: "SD-0002", order_id: "o2", vehicle_id: "v2", planned_gate_entry: ago(330), planned_qty: 500, status: "In Progress", created_at: ago(360) }
      ],
      trips: [
        { id: "t1", trip_no: "TRIP-0001", schedule_id: "s1", order_id: "o1", vehicle_id: "v1", order_no: "ORD-0001", schedule_no: "SD-0001", vehicle_number: "AS01SC-6927", party_name: "Britannia", item_name: "Refined Wheat Flour(Tanker)", qty: 500, driver_name: "Demo Driver", current_stage: "LOADING_START", status: "Loading", planned_gate_entry: ago(120), actual_gate_entry: ago(113), actual_empty_weighment: ago(92), actual_loading_start: ago(42), actual_loading_complete: null, actual_loaded_weighment: null, actual_documentation: null, actual_gate_out: null, actual_party_store: null, actual_pod: null, empty_weight: 15420, created_at: ago(170), updated_at: ago(42) },
        { id: "t2", trip_no: "TRIP-0002", schedule_id: "s2", order_id: "o2", vehicle_id: "v2", order_no: "ORD-0002", schedule_no: "SD-0002", vehicle_number: "AS01QC-6569", party_name: "Britannia", item_name: "Refined Wheat Flour(Tanker)", qty: 500, driver_name: "Demo Driver", current_stage: "PARTY_STORE", status: "At Party", planned_gate_entry: ago(330), actual_gate_entry: ago(322), actual_empty_weighment: ago(307), actual_loading_start: ago(295), actual_loading_complete: ago(230), actual_loaded_weighment: ago(216), actual_documentation: ago(200), actual_gate_out: ago(180), actual_party_store: ago(15), actual_pod: null, empty_weight: 15380, loaded_weight: 25380, net_weight: 10000, created_at: ago(360), updated_at: ago(15) }
      ],
      events: [
        { id: "e1", trip_id: "t1", trip_no: "TRIP-0001", vehicle_number: "AS01SC-6927", stage_key: "EMPTY_WEIGHMENT", stage_label: "Gate Entry → Empty Weighment", planned_time: ago(103), actual_time: ago(92), duration_minutes: 21, delay_minutes: 11 },
        { id: "e2", trip_id: "t1", trip_no: "TRIP-0001", vehicle_number: "AS01SC-6927", stage_key: "LOADING_START", stage_label: "Empty Weighment → Loading Start", planned_time: ago(82), actual_time: ago(42), duration_minutes: 50, delay_minutes: 40 },
        { id: "e3", trip_id: "t2", trip_no: "TRIP-0002", vehicle_number: "AS01QC-6569", stage_key: "DOCUMENTATION", stage_label: "Loaded Weighment → Documentation", planned_time: ago(206), actual_time: ago(200), duration_minutes: 16, delay_minutes: 6 }
      ],
      targets: Object.keys(TARGETS).map(function (key) { return { stage_key: key, stage_label: TARGETS[key][0], target_minutes: TARGETS[key][1], stage_sequence: TARGETS[key][2] }; })
    };
  })();

  async function signIn(email, password) {
    if (!configured()) return { demo: true };
    var response = await fetch(base() + "/auth/v1/token?grant_type=password", {
      method: "POST", headers: { apikey: anon(), "Content-Type": "application/json" },
      body: JSON.stringify({ email: email, password: password })
    });
    var result = await response.json();
    if (!response.ok) throw new Error(result.error_description || result.msg || "Sign in failed");
    sessionStorage.setItem(TOKEN_KEY, result.access_token);
    if (result.refresh_token) sessionStorage.setItem(REFRESH_KEY, result.refresh_token);
    return result;
  }
  function signOut() { sessionStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(REFRESH_KEY); }
  function hasSession() { return !configured() || !!sessionStorage.getItem(TOKEN_KEY); }

  async function getData() {
    if (!configured()) return JSON.parse(JSON.stringify(demo));
    var all = await Promise.all([
      request("vehicle_master", "?select=*&order=vehicle_code.asc"),
      request("orders", "?select=*&order=created_at.desc&limit=1000"),
      request("schedules", "?select=*&order=planned_gate_entry.desc&limit=1000"),
      request("trips", "?select=*&order=created_at.desc&limit=1000"),
      request("stage_events", "?select=*&order=actual_time.desc&limit=3000"),
      request("stage_targets", "?select=*&order=stage_sequence.asc")
    ]);
    return { vehicles: all[0] || [], orders: all[1] || [], schedules: all[2] || [], trips: all[3] || [], events: all[4] || [], targets: all[5] || [] };
  }

  async function createOrder(input) {
    input = Object.assign({}, input, { item_name: "Refined Wheat Flour(Tanker)" });
    delete input.required_by;
    if (!configured()) {
      var row = Object.assign({ id: uuid(), order_no: "ORD-DEMO-" + (demo.orders.length + 1), scheduled_qty: 0, delivered_qty: 0, status: "Open", created_at: new Date().toISOString() }, input);
      demo.orders.unshift(row); return row;
    }
    var rows = await request("orders", "", { method: "POST", prefer: "return=representation", body: JSON.stringify(input) });
    mirror(); return one(rows);
  }

  async function addVehicle(input) {
    if (!configured()) {
      var row = Object.assign({ id: uuid(), active: true, status: "Available", last_pod_at: null, next_available_at: null }, input);
      demo.vehicles.push(row); return row;
    }
    var rows = await request("vehicle_master", "", { method: "POST", prefer: "return=representation", body: JSON.stringify(input) });
    mirror(); return one(rows);
  }

  async function createSchedule(input, data) {
    var order = data.orders.find(function (x) { return x.id === input.order_id; });
    var vehicle = data.vehicles.find(function (x) { return x.id === input.vehicle_id; });
    if (!order || !vehicle) throw new Error("Select a valid order and vehicle.");
    if (+input.planned_qty > (+order.order_qty - +order.scheduled_qty)) throw new Error("Quantity exceeds the order balance.");
    if (data.trips.some(function (x) { return x.vehicle_id === vehicle.id && ["Completed", "Cancelled"].indexOf(x.status) < 0; })) throw new Error("Vehicle already has an active trip.");
    if (vehicle.next_available_at && new Date(input.planned_gate_entry) < new Date(vehicle.next_available_at)) throw new Error("Gate entry must be after POD + 2 hours: " + new Date(vehicle.next_available_at).toLocaleString());

    if (!configured()) {
      var sid = uuid(), sno = "SD-DEMO-" + (demo.schedules.length + 1);
      var schedule = { id: sid, schedule_no: sno, order_id: order.id, vehicle_id: vehicle.id, planned_gate_entry: input.planned_gate_entry, planned_qty: +input.planned_qty, status: "Planned", created_at: new Date().toISOString() };
      var trip = { id: uuid(), trip_no: "TRIP-DEMO-" + (demo.trips.length + 1), schedule_id: sid, order_id: order.id, vehicle_id: vehicle.id, order_no: order.order_no, schedule_no: sno, vehicle_number: vehicle.vehicle_number, party_name: order.party_name, item_name: order.item_name, qty: +input.planned_qty, current_stage: "SCHEDULE", status: "Waiting", planned_gate_entry: input.planned_gate_entry, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      demo.schedules.unshift(schedule); demo.trips.unshift(trip);
      var demoOrder = demo.orders.find(function (x) { return x.id === order.id; });
      var demoVehicle = demo.vehicles.find(function (x) { return x.id === vehicle.id; });
      if (demoOrder) demoOrder.scheduled_qty = +demoOrder.scheduled_qty + +input.planned_qty;
      if (demoVehicle) demoVehicle.status = "On Trip";
      return trip;
    }
    var srows = await request("schedules", "", { method: "POST", prefer: "return=representation", body: JSON.stringify(input) });
    var scheduleLive = one(srows);
    var payload = { schedule_id: scheduleLive.id, order_id: order.id, vehicle_id: vehicle.id, order_no: order.order_no, schedule_no: scheduleLive.schedule_no, vehicle_number: vehicle.vehicle_number, party_name: order.party_name, item_name: order.item_name, qty: +input.planned_qty, current_stage: "SCHEDULE", status: "Waiting", planned_gate_entry: input.planned_gate_entry };
    var trows = await request("trips", "", { method: "POST", prefer: "return=representation", body: JSON.stringify(payload) });
    await Promise.all([
      request("orders", "?id=eq." + encodeURIComponent(order.id), { method: "PATCH", prefer: "return=minimal", body: JSON.stringify({ scheduled_qty: +order.scheduled_qty + +input.planned_qty }) }),
      request("vehicle_master", "?id=eq." + encodeURIComponent(vehicle.id), { method: "PATCH", prefer: "return=minimal", body: JSON.stringify({ status: "On Trip" }) })
    ]);
    mirror(); return one(trows);
  }

  async function completeStage(trip, stage, actual, details, data) {
    if (stage !== nextStage(trip.current_stage)) throw new Error("Next valid stage is " + nextStage(trip.current_stage));
    actual = iso(actual); details = details || {};
    if (stage === "GATE_ENTRY" && !String(details.driver_name || "").trim()) throw new Error("Enter the Driver Name before completing Gate Entry.");
    if (stage === "DOCUMENTATION" && (!details.invoice_no || !details.coa_no || !details.invoice_file_path || !details.coa_file_path)) throw new Error("Invoice number, COA number, and both document uploads are required.");
    if (stage === "GATE_OUT") {
      var checks = details.gate_out_checklist || {};
      var requiredChecks = ["invoice_verified", "lr_verified", "vehicle_verified", "documents_verified", "weighment_done"];
      if (requiredChecks.some(function (key) { return checks[key] !== true; })) throw new Error("Complete every Gate Out verification checkbox.");
      if (!String(details.gate_out_verified_by || "").trim()) throw new Error("Enter the Verified by Name.");
    }
    var previous = previousActual(trip, stage) || trip.created_at;
    var target = TARGETS[stage] || [stage, 0, STAGES.indexOf(stage) + 1];
    var planned = stage === "GATE_ENTRY" ? trip.planned_gate_entry : addMinutes(previous, target[1]);
    var patch = { current_stage: stage, status: statusFor(stage), updated_at: actual };
    patch[actualField(stage)] = actual;
    ["driver_name", "empty_weight", "loaded_weight", "invoice_no", "coa_no", "invoice_file_path", "coa_file_path", "gate_out_checklist", "gate_out_verified_by", "pod_reference", "remarks"].forEach(function (key) { if (details[key] !== undefined && details[key] !== "") patch[key] = details[key]; });
    if (stage === "LOADED_WEIGHMENT") patch.net_weight = (+details.loaded_weight || 0) - (+trip.empty_weight || 0);

    if (!configured()) {
      var demoTrip = demo.trips.find(function (x) { return x.id === trip.id; }) || trip;
      Object.assign(demoTrip, patch);
      var event = { id: uuid(), trip_id: demoTrip.id, trip_no: demoTrip.trip_no, vehicle_number: demoTrip.vehicle_number, stage_key: stage, stage_label: target[0], stage_sequence: target[2], planned_time: planned, actual_time: actual, duration_minutes: minutes(previous, actual), delay_minutes: Math.round((new Date(actual) - new Date(planned)) / 60000), details: details };
      demo.events.unshift(event);
      var dv = demo.vehicles.find(function (x) { return x.id === demoTrip.vehicle_id; }); if (dv) dv.status = stage === "POD" ? "Ready for Next Trip" : patch.status;
      if (stage === "POD") {
        if (dv) { dv.last_pod_at = actual; dv.next_available_at = addMinutes(actual, 120); }
        var ds = demo.schedules.find(function (x) { return x.id === demoTrip.schedule_id; }); if (ds) ds.status = "Completed";
        var dOrder = demo.orders.find(function (x) { return x.id === demoTrip.order_id; });
        if (dOrder) { dOrder.delivered_qty = Math.min(+dOrder.order_qty, +dOrder.delivered_qty + +demoTrip.qty); dOrder.status = dOrder.delivered_qty >= +dOrder.order_qty ? "Closed" : "Partial"; }
      }
      return demoTrip;
    }
    var updatedRows = await request("trips", "?id=eq." + encodeURIComponent(trip.id), { method: "PATCH", prefer: "return=representation", body: JSON.stringify(patch) });
    var updated = one(updatedRows);
    var eventPayload = { trip_id: trip.id, trip_no: trip.trip_no, vehicle_number: trip.vehicle_number, stage_key: stage, stage_label: target[0], stage_sequence: target[2], planned_time: planned, actual_time: actual, duration_minutes: minutes(previous, actual), delay_minutes: Math.round((new Date(actual) - new Date(planned)) / 60000), details: details };
    await request("stage_events", "?on_conflict=trip_id,stage_key", { method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: JSON.stringify(eventPayload) });
    var jobs = [request("vehicle_master", "?id=eq." + encodeURIComponent(trip.vehicle_id), { method: "PATCH", prefer: "return=minimal", body: JSON.stringify({ status: stage === "POD" ? "Ready for Next Trip" : patch.status, ...(stage === "POD" ? { last_pod_at: actual, next_available_at: addMinutes(actual, 120) } : {}) }) })];
    if (stage === "GATE_ENTRY") jobs.push(request("schedules", "?id=eq." + encodeURIComponent(trip.schedule_id), { method: "PATCH", prefer: "return=minimal", body: JSON.stringify({ status: "In Progress" }) }));
    if (stage === "POD") {
      var order = data.orders.find(function (x) { return x.id === trip.order_id; });
      jobs.push(request("schedules", "?id=eq." + encodeURIComponent(trip.schedule_id), { method: "PATCH", prefer: "return=minimal", body: JSON.stringify({ status: "Completed" }) }));
      if (order) { var delivered = Math.min(+order.order_qty, +order.delivered_qty + +trip.qty); jobs.push(request("orders", "?id=eq." + encodeURIComponent(order.id), { method: "PATCH", prefer: "return=minimal", body: JSON.stringify({ delivered_qty: delivered, status: delivered >= +order.order_qty ? "Closed" : "Partial" }) })); }
    }
    await Promise.all(jobs); mirror(); return updated;
  }

  window.BulkerAPI = { build: BUILD, configured: configured, hasSession: hasSession, signIn: signIn, signOut: signOut, getData: getData, createOrder: createOrder, addVehicle: addVehicle, createSchedule: createSchedule, uploadDocument: uploadDocument, completeStage: completeStage, nextStage: nextStage, stages: STAGES, targets: TARGETS };

  /* Copy the SQL below into Supabase > SQL Editor and run it once. */
  window.BULKER_SCHEMA_SQL = String.raw`create extension if not exists pgcrypto;
create sequence if not exists order_no_seq start 1;
create sequence if not exists schedule_no_seq start 1;
create sequence if not exists trip_no_seq start 1;

create table if not exists vehicle_master (
 id uuid primary key default gen_random_uuid(), vehicle_code text not null unique,
 vehicle_number text not null unique, active boolean not null default true,
 status text not null default 'Available', last_pod_at timestamptz, next_available_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists orders (
 id uuid primary key default gen_random_uuid(), order_no text not null unique default ('ORD-'||lpad(nextval('order_no_seq')::text,4,'0')),
 order_date date not null default current_date, party_name text not null, item_name text not null default 'Refined Wheat Flour(Tanker)',
 order_qty numeric not null check(order_qty>0), scheduled_qty numeric not null default 0,
 delivered_qty numeric not null default 0, status text not null default 'Open', required_by date, remarks text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists schedules (
 id uuid primary key default gen_random_uuid(), schedule_no text not null unique default ('SD-'||lpad(nextval('schedule_no_seq')::text,4,'0')),
 order_id uuid not null references orders(id), vehicle_id uuid not null references vehicle_master(id),
 planned_gate_entry timestamptz not null, planned_qty numeric not null check(planned_qty>0),
 status text not null default 'Planned', created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists trips (
 id uuid primary key default gen_random_uuid(), trip_no text not null unique default ('TRIP-'||lpad(nextval('trip_no_seq')::text,4,'0')),
 schedule_id uuid not null unique references schedules(id), order_id uuid not null references orders(id), vehicle_id uuid not null references vehicle_master(id),
 order_no text not null, schedule_no text not null, vehicle_number text not null, party_name text not null, item_name text not null, qty numeric not null,
 current_stage text not null default 'SCHEDULE', status text not null default 'Waiting', planned_gate_entry timestamptz,
 actual_gate_entry timestamptz, actual_empty_weighment timestamptz, actual_loading_start timestamptz, actual_loading_complete timestamptz,
 actual_loaded_weighment timestamptz, actual_documentation timestamptz, actual_gate_out timestamptz, actual_party_store timestamptz, actual_pod timestamptz,
 driver_name text, empty_weight numeric, loaded_weight numeric, net_weight numeric, invoice_no text, coa_no text,
 invoice_file_path text, coa_file_path text, gate_out_checklist jsonb, gate_out_verified_by text, pod_reference text, remarks text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists stage_events (
 id uuid primary key default gen_random_uuid(), trip_id uuid not null references trips(id) on delete cascade,
 trip_no text not null, vehicle_number text not null, stage_key text not null, stage_label text not null, stage_sequence int not null,
 planned_time timestamptz, actual_time timestamptz, duration_minutes int, delay_minutes int, details jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(trip_id,stage_key)
);
create table if not exists stage_targets (
 stage_key text primary key, stage_label text not null, target_minutes int not null, stage_sequence int not null unique
);
alter table orders alter column item_name set default 'Refined Wheat Flour(Tanker)';
alter table trips add column if not exists driver_name text;
alter table trips add column if not exists invoice_file_path text;
alter table trips add column if not exists coa_file_path text;
alter table trips add column if not exists gate_out_checklist jsonb;
alter table trips add column if not exists gate_out_verified_by text;
alter table stage_events add column if not exists details jsonb not null default '{}'::jsonb;
insert into vehicle_master(vehicle_code,vehicle_number) values ('Veh1','AS01SC-6927'),('Veh2','AS01QC-6569') on conflict(vehicle_number) do nothing;
insert into stage_targets values
('GATE_ENTRY','Schedule → Gate Entry',0,3),('EMPTY_WEIGHMENT','Gate Entry → Empty Weighment',10,4),
('LOADING_START','Empty Weighment → Loading Start',10,5),('LOADING_COMPLETE','Loading Start → Loading Complete',360,6),
('LOADED_WEIGHMENT','Loading Complete → Loaded Weighment',10,7),('DOCUMENTATION','Loaded Weighment → Documentation',10,8),
('GATE_OUT','Documentation → Gate Out',10,9),('PARTY_STORE','Gate Out → Party Store',1410,10),('POD','Party Store → POD',30,11)
on conflict(stage_key) do update set stage_label=excluded.stage_label,target_minutes=excluded.target_minutes,stage_sequence=excluded.stage_sequence;
create unique index if not exists one_active_trip_per_vehicle on trips(vehicle_id) where status not in ('Completed','Cancelled');
alter table vehicle_master enable row level security; alter table orders enable row level security;
alter table schedules enable row level security; alter table trips enable row level security;
alter table stage_events enable row level security; alter table stage_targets enable row level security;
do $$ declare t text; begin foreach t in array array['vehicle_master','orders','schedules','trips','stage_events','stage_targets'] loop
 execute format('drop policy if exists "fms authenticated read" on %I',t);
 execute format('create policy "fms authenticated read" on %I for select to authenticated using(true)',t);
 execute format('drop policy if exists "fms authenticated insert" on %I',t);
 execute format('create policy "fms authenticated insert" on %I for insert to authenticated with check(true)',t);
 execute format('drop policy if exists "fms authenticated update" on %I',t);
 execute format('create policy "fms authenticated update" on %I for update to authenticated using(true) with check(true)',t);
 end loop; end $$;
grant usage on schema public to authenticated; grant usage,select on all sequences in schema public to authenticated;
grant select,insert,update on vehicle_master,orders,schedules,trips,stage_events to authenticated; grant select on stage_targets to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('bulker-documents','bulker-documents',false,10485760,array['application/pdf','image/jpeg','image/png','image/webp'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
drop policy if exists "bulker documents read" on storage.objects;
create policy "bulker documents read" on storage.objects for select to authenticated using(bucket_id='bulker-documents');
drop policy if exists "bulker documents insert" on storage.objects;
create policy "bulker documents insert" on storage.objects for insert to authenticated with check(bucket_id='bulker-documents');
drop policy if exists "bulker documents update" on storage.objects;
create policy "bulker documents update" on storage.objects for update to authenticated using(bucket_id='bulker-documents') with check(bucket_id='bulker-documents');`;
})();
