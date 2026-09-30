/* Trail at Home: ride history storage (IndexedDB).
   Each ride is a small record in "rides" plus its 1 Hz samples in "rideSamples", saved in
   30-second chunks while riding, so a crash loses little.

   Record: { id, routeId, routeName, startedAt, startTimeISO, endedAt, finished, hasTrack,
             sampleCount, chunks, summary, upload: { status, activityId?, uploadId?, error?, retryable? } }
   upload.status: "none" | "pending" | "processing" | "uploaded" | "failed"

   createRideStore(db) -> { saveChunk, finish, get, list, remove, prune, setUpload }
     db() resolves to an open IDBDatabase with "rides" and "rideSamples" stores. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./tcx.js"));
  else root.TAH = Object.assign(root.TAH || {}, factory(root.TAH));
})(typeof self !== "undefined" ? self : this, function (tcx) {
"use strict";

const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const txDone = t => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
const range = id => IDBKeyRange.bound([id, 0], [id, Infinity]);
// Rides still waiting to reach Strava are never pruned.
const QUEUED = u => u && (u.status === "pending" || u.status === "processing" || (u.status === "failed" && u.retryable));

function createRideStore(db) {
  // Fields owned by the ride while it's being recorded; everything else (upload status) is left alone.
  const OWN = ["id", "routeId", "routeName", "startedAt", "startTimeISO", "endedAt", "startDistM", "endDistM", "finished", "hasTrack", "sampleCount", "chunks", "summary"];
  async function mergePut(store, log) {
    const cur = await reqP(store.get(log.id)) || { upload: { status: "none" } };
    for (const k of OWN) if (k in log) cur[k] = log[k];
    if (!cur.startTimeISO && cur.startedAt) cur.startTimeISO = new Date(cur.startedAt).toISOString();
    store.put(cur);
  }

  async function saveChunk(log, samples) {
    const d = await db(), t = d.transaction(["rides", "rideSamples"], "readwrite");
    log.sampleCount += samples.length;
    t.objectStore("rideSamples").put({ rideId: log.id, seq: log.chunks++, samples });
    await mergePut(t.objectStore("rides"), log);
    return txDone(t);
  }
  async function samplesOf(id) {
    const d = await db();
    const chunks = await reqP(d.transaction("rideSamples").objectStore("rideSamples").getAll(range(id)));
    return chunks.sort((a, b) => a.seq - b.seq).flatMap(c => c.samples);
  }
  // The ride has ended: store its summary alongside the record.
  async function finish(log) {
    log.summary = tcx.summarize(await samplesOf(log.id));
    const d = await db(), t = d.transaction("rides", "readwrite");
    await mergePut(t.objectStore("rides"), log);
    return txDone(t);
  }
  async function get(id, withSamples = true) {
    const d = await db(), rec = await reqP(d.transaction("rides").objectStore("rides").get(id));
    if (!rec) return null;
    if (!rec.upload) rec.upload = { status: "none" };
    if (withSamples) rec.samples = await samplesOf(id);
    return rec;
  }
  // Newest first. Rides saved before summaries existed get one now (once).
  async function list() {
    const d = await db(), all = await reqP(d.transaction("rides").objectStore("rides").getAll());
    for (const r of all) {
      if (!r.upload) r.upload = { status: "none" };
      if (!r.startTimeISO && r.startedAt) r.startTimeISO = new Date(r.startedAt).toISOString();
      if (!r.summary && r.sampleCount) {
        r.summary = tcx.summarize(await samplesOf(r.id));
        const t = (await db()).transaction("rides", "readwrite"); t.objectStore("rides").put(r); await txDone(t).catch(() => {});
      }
    }
    return all.sort((a, b) => b.startedAt - a.startedAt);
  }
  async function remove(id) {
    const d = await db(), t = d.transaction(["rides", "rideSamples"], "readwrite");
    t.objectStore("rides").delete(id); t.objectStore("rideSamples").delete(range(id));
    return txDone(t);
  }
  async function prune(keep) {
    const all = await list();
    for (const r of all.slice(keep)) if (!QUEUED(r.upload)) await remove(r.id);
  }
  async function setUpload(id, upload) {
    const d = await db(), t = d.transaction("rides", "readwrite"), s = t.objectStore("rides");
    const rec = await reqP(s.get(id));
    if (!rec) return null;
    rec.upload = Object.assign({ status: "none" }, upload, { updatedAt: Date.now() });
    s.put(rec);
    await txDone(t);
    return rec.upload;
  }
  return { saveChunk, finish, get, list, remove, prune, setUpload, samples: samplesOf, isQueued: QUEUED };
}

return { createRideStore };
});
