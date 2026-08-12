import "dotenv/config";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, normalize, resolve } from "node:path";
import admin from "firebase-admin";

const root = process.cwd();
const port = Number(process.env.PORT || 3000);
const projectId = process.env.FIREBASE_PROJECT_ID;

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const firebaseReady = initializeFirebaseAdmin();
const db = firebaseReady ? admin.firestore() : null;

createServer(async (request, response) => {
  try {
    if (request.url?.startsWith("/api/")) {
      await handleApi(request, response);
      return;
    }
    serveStatic(request, response);
  } catch (error) {
    sendJson(response, error.status || 500, { error: error.message || "Server error" });
  }
}).listen(port, process.env.HOST || '0.0.0.0', () => {
  console.log(`PG Manager running on port ${port}`);
});

async function handleApi(request, response) {
  const url = new URL(request.url || "/", `http://${request.headers.host}`);

  if (request.method === "GET" && url.pathname === "/api/firebase-config") {
    const config = getFirebaseClientConfig();
    if (!config.apiKey || !config.authDomain || !config.projectId || !config.appId) {
      sendJson(response, 500, { error: "Firebase client environment variables are missing." });
      return;
    }
    sendJson(response, 200, config);
    return;
  }

  ensureFirebaseReady();

  if (request.method === "GET" && url.pathname === "/api/bootstrap") {
    const session = await requireSession(request);
    const data = session.profile.role === "admin" ? await getAdminBootstrap(session.profile) : await getResidentBootstrap(session.profile);
    sendJson(response, 200, data);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/admin/residents") {
    const session = await requireAdmin(request);
    const body = await readJson(request);
    const resident = await createResident(body, session.profile);
    sendJson(response, 201, { resident });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/admin/property/floors") {
    const session = await requireAdmin(request);
    const body = await readJson(request);
    const result = await createFloorStructure(body, session.profile);
    sendJson(response, 201, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/admin/property/rooms") {
    const session = await requireAdmin(request);
    const body = await readJson(request);
    const room = await upsertRoomStructure(body, session.profile);
    sendJson(response, 201, { room });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/admin/pg") {
    const session = await requireAdmin(request);
    const body = await readJson(request);
    const pg = await updatePgProfile(session.profile, body);
    sendJson(response, 200, { pg });
    return;
  }

  const removeMatch = url.pathname.match(/^\/api\/admin\/residents\/([^/]+)\/remove$/);
  if (request.method === "POST" && removeMatch) {
    const session = await requireAdmin(request);
    const resident = await getResidentForAdmin(removeMatch[1], session.profile);
    await db.collection("users").doc(removeMatch[1]).set(
      {
        status: "left",
        pgId: resident.existing.pgId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    sendJson(response, 200, { ok: true });
    return;
  }

  const updateResidentMatch = url.pathname.match(/^\/api\/admin\/residents\/([^/]+)\/update$/);
  if (request.method === "POST" && updateResidentMatch) {
    const session = await requireAdmin(request);
    const body = await readJson(request);
    const resident = await updateResident(updateResidentMatch[1], body, session.profile);
    sendJson(response, 200, { resident });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/payments") {
    const session = await requireSession(request);
    const body = await readJson(request);
    const payment = await createPayment(session.profile, body);
    sendJson(response, 201, { payment });
    return;
  }

  const paymentMatch = url.pathname.match(/^\/api\/payments\/([^/]+)\/(approve|reject)$/);
  if (request.method === "POST" && paymentMatch) {
    const session = await requireAdmin(request);
    await reviewPayment(paymentMatch[1], paymentMatch[2], session.profile);
    sendJson(response, 200, { ok: true });
    return;
  }

  sendJson(response, 404, { error: "API route not found." });
}

async function createResident(body, adminProfile) {
  const resident = validateResident(body);
  await ensureRoomBedExists(adminProfile.pgId, resident.room, resident.bed);
  const bedTaken = await isBedTaken(adminProfile.pgId, resident.room, resident.bed);
  if (bedTaken) throw httpError(409, `Room ${resident.room}, bed ${resident.bed} is already occupied.`);

  let authUser;
  try {
    authUser = await admin.auth().createUser({
      email: resident.email,
      password: body.password,
      displayName: resident.name,
      emailVerified: false,
      disabled: false,
    });
  } catch (error) {
    if (error.code === "auth/email-already-exists") throw httpError(409, "This Gmail is already added.");
    throw error;
  }

  const profile = {
    id: authUser.uid,
    uid: authUser.uid,
    pgId: adminProfile.pgId,
    role: "resident",
    status: "active",
    ...resident,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await db.collection("users").doc(authUser.uid).set(profile);
  return { ...profile, createdAt: null, updatedAt: null };
}

async function updateResident(residentId, body, adminProfile) {
  const { ref, existing } = await getResidentForAdmin(residentId, adminProfile);

  const resident = validateResidentDetails(body);
  await ensureRoomBedExists(adminProfile.pgId, resident.room, resident.bed);
  const movingBed = existing.room !== resident.room || existing.bed !== resident.bed;
  if (movingBed && (await isBedTaken(adminProfile.pgId, resident.room, resident.bed, residentId))) {
    throw httpError(409, `Room ${resident.room}, bed ${resident.bed} is already occupied.`);
  }

  const update = {
    ...resident,
    pgId: adminProfile.pgId,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  await ref.set(update, { merge: true });
  return { id: residentId, ...existing, ...update, updatedAt: null };
}

async function createFloorStructure(body, adminProfile) {
  const startFloorNumber = Number(body.floorNumber);
  const floorCount = Number(body.floorCount);
  const roomCount = Number(body.roomCount);
  const bedsPerRoom = Number(body.bedsPerRoom);

  if (!startFloorNumber || startFloorNumber < 1 || startFloorNumber > 99) throw httpError(400, "Start floor number must be between 1 and 99.");
  if (!floorCount || floorCount < 1 || floorCount > 20) throw httpError(400, "Floor count must be between 1 and 20.");
  if (!roomCount || roomCount < 1 || roomCount > 100) throw httpError(400, "Rooms count must be between 1 and 100.");
  if (!bedsPerRoom || bedsPerRoom < 1 || bedsPerRoom > 20) throw httpError(400, "Beds per room must be between 1 and 20.");
  if (floorCount * roomCount > 450) throw httpError(400, "Create up to 450 rooms at one time.");

  const batch = db.batch();
  const rooms = [];
  for (let floorOffset = 0; floorOffset < floorCount; floorOffset += 1) {
    const floorNumber = startFloorNumber + floorOffset;
    const floorName = `Floor ${floorNumber}`;
    for (let index = 1; index <= roomCount; index += 1) {
      const roomNumber = `${floorNumber}${String(index).padStart(2, "0")}`;
      const existing = await findRoom(adminProfile.pgId, roomNumber);
      if (existing) {
        throw httpError(409, `Room ${roomNumber} already exists. Use particular room update instead.`);
      }
      const room = buildRoom(adminProfile.pgId, roomNumber, floorName, bedsPerRoom);
      rooms.push(room);
      batch.set(db.collection("rooms").doc(roomDocId(adminProfile.pgId, roomNumber)), room, { merge: true });
    }
  }
  await batch.commit();
  return { rooms };
}

async function upsertRoomStructure(body, adminProfile) {
  const floorName = clean(body.floorName) || `Floor ${Number(body.floorNumber) || 1}`;
  const roomNumber = clean(body.roomNumber).toUpperCase();
  const bedCount = Number(body.bedCount);

  if (!roomNumber) throw httpError(400, "Room number is required.");
  if (!bedCount || bedCount < 1 || bedCount > 20) throw httpError(400, "Bed count must be between 1 and 20.");

  const existing = await findRoom(adminProfile.pgId, roomNumber);
  if (existing) {
    const occupiedBedsSnapshot = await db
      .collection("users")
      .where("pgId", "==", adminProfile.pgId)
      .where("role", "==", "resident")
      .where("status", "==", "active")
      .where("room", "==", roomNumber)
      .get();
    const newBeds = createBedLabels(bedCount);
    const removedOccupiedBed = occupiedBedsSnapshot.docs.some((doc) => !newBeds.includes(doc.data().bed));
    if (removedOccupiedBed) throw httpError(409, "This room has residents in beds that would be removed.");
  }

  const room = buildRoom(adminProfile.pgId, roomNumber, floorName, bedCount);
  await db.collection("rooms").doc(existing?.id || roomDocId(adminProfile.pgId, roomNumber)).set(room, { merge: true });
  return room;
}

async function createPayment(profile, body) {
  if (profile.role !== "resident" || profile.status !== "active") {
    throw httpError(403, "Only active residents can submit payments.");
  }

  const amount = Number(body.amount);
  const method = clean(body.method);
  const transactionId = clean(body.transactionId);
  const paidOn = clean(body.paidOn);
  const month = getMonthKey(new Date());
  const proofImage = validatePaymentProof(body.proofImage);

  if (!amount || amount < 1) throw httpError(400, "Payment amount is required.");
  if (!method || !transactionId || !paidOn) throw httpError(400, "Payment method, transaction ID, and date are required.");

  const existing = await db
    .collection("payments")
    .where("pgId", "==", profile.pgId)
    .where("residentId", "==", profile.id)
    .where("month", "==", month)
    .where("status", "==", "pending")
    .get();
  if (!existing.empty) throw httpError(409, "You already have a payment waiting for admin approval.");

  const paymentRef = db.collection("payments").doc();
  const payment = {
    id: paymentRef.id,
    pgId: profile.pgId,
    residentId: profile.id,
    residentEmail: profile.email,
    month,
    amount,
    method,
    transactionId,
    paidOn,
    status: "pending",
    note: clean(body.note),
    proofImage,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  await paymentRef.set(payment);
  return { ...payment, createdAt: null, updatedAt: null };
}

async function reviewPayment(paymentId, action, adminProfile) {
  const paymentRef = db.collection("payments").doc(paymentId);
  const snapshot = await paymentRef.get();
  if (!snapshot.exists) throw httpError(404, "Payment not found.");
  if (snapshot.data().pgId !== adminProfile.pgId) throw httpError(404, "Payment not found for this PG.");
  await paymentRef.set(
    {
      status: action === "approve" ? "approved" : "rejected",
      reviewedOn: getIsoDate(new Date()),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

async function getAdminBootstrap(profile) {
  const [pg, usersSnapshot, roomsSnapshot, paymentsSnapshot] = await Promise.all([
    getPgProfile(profile.pgId),
    db.collection("users").where("pgId", "==", profile.pgId).get(),
    db.collection("rooms").where("pgId", "==", profile.pgId).get(),
    db.collection("payments").where("pgId", "==", profile.pgId).get(),
  ]);

  return {
    pg,
    profile: serializeDoc(profile.id, profile),
    users: usersSnapshot.docs.map((doc) => serializeDoc(doc.id, doc.data())),
    rooms: roomsSnapshot.docs.map((doc) => serializeDoc(doc.id, doc.data())),
    payments: paymentsSnapshot.docs.map((doc) => serializeDoc(doc.id, doc.data())),
  };
}

async function getResidentBootstrap(profile) {
  const [pg, paymentsSnapshot] = await Promise.all([
    getPgProfile(profile.pgId),
    db.collection("payments").where("pgId", "==", profile.pgId).where("residentId", "==", profile.id).get(),
  ]);
  return {
    pg,
    profile: serializeDoc(profile.id, profile),
    users: [serializeDoc(profile.id, profile)],
    rooms: [],
    payments: paymentsSnapshot.docs.map((doc) => serializeDoc(doc.id, doc.data())),
  };
}

async function requireAdmin(request) {
  const session = await requireSession(request);
  if (session.profile.role !== "admin") throw httpError(403, "Admin access required.");
  return session;
}

async function requireSession(request) {
  const header = request.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) throw httpError(401, "Login required.");

  const decoded = await admin.auth().verifyIdToken(token);
  const profileSnapshot = await db.collection("users").doc(decoded.uid).get();
  if (!profileSnapshot.exists) throw httpError(403, "Your account profile is not configured.");
  const profile = await ensurePgContext(profileSnapshot.id, profileSnapshot.data());
  return {
    auth: decoded,
    profile,
  };
}

async function isBedTaken(pgId, room, bed, exceptResidentId = null) {
  const snapshot = await db
    .collection("users")
    .where("pgId", "==", pgId)
    .where("role", "==", "resident")
    .where("status", "==", "active")
    .where("room", "==", room)
    .where("bed", "==", bed)
    .get();
  return snapshot.docs.some((doc) => doc.id !== exceptResidentId);
}

async function ensureRoomBedExists(pgId, room, bed) {
  const roomDoc = await findRoom(pgId, room);
  if (!roomDoc) throw httpError(400, "Create this room in Property Structure before assigning a resident.");
  const roomData = roomDoc.data;
  if (!Array.isArray(roomData.beds) || !roomData.beds.includes(bed)) {
    throw httpError(400, `Bed ${bed} is not configured in room ${room}.`);
  }
}

async function findRoom(pgId, roomNumber) {
  const snapshot = await db.collection("rooms").where("pgId", "==", pgId).where("number", "==", roomNumber).limit(1).get();
  if (snapshot.empty) return null;
  const doc = snapshot.docs[0];
  return { id: doc.id, data: doc.data() };
}

async function getResidentForAdmin(residentId, adminProfile) {
  const ref = db.collection("users").doc(residentId);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw httpError(404, "Resident not found.");
  const existing = snapshot.data();
  if (existing.role !== "resident") throw httpError(400, "Only resident profiles can be updated.");
  if (existing.pgId !== adminProfile.pgId) throw httpError(404, "Resident not found for this PG.");
  return { ref, existing };
}

async function getPgProfile(pgId) {
  if (!pgId) return null;
  const snapshot = await db.collection("pgs").doc(pgId).get();
  if (!snapshot.exists) return { id: pgId, name: "My PG", address: "" };
  return serializeDoc(snapshot.id, snapshot.data());
}

async function updatePgProfile(adminProfile, body) {
  const name = clean(body.name);
  const address = clean(body.address);
  if (!name) throw httpError(400, "PG name is required.");
  if (name.length > 80) throw httpError(400, "PG name must be under 80 characters.");
  if (address.length > 240) throw httpError(400, "PG address must be under 240 characters.");

  const pg = {
    id: adminProfile.pgId,
    name,
    address,
    ownerUid: adminProfile.id,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  await db.collection("pgs").doc(adminProfile.pgId).set(pg, { merge: true });
  await db.collection("users").doc(adminProfile.id).set({ pgName: name, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  return { ...pg, updatedAt: null };
}

async function ensurePgContext(uid, data) {
  const profile = { id: uid, ...data };
  if (profile.pgId) {
    if (profile.role === "admin") await ensurePgDoc(profile);
    return profile;
  }

  if (profile.role !== "admin") {
    throw httpError(403, "This resident is not linked to a PG yet. Ask the PG owner to log in once.");
  }

  const pgId = `pg_${uid}`;
  const updatedProfile = { ...profile, pgId, pgName: profile.pgName || "My PG" };
  await db.collection("users").doc(uid).set(
    {
      pgId,
      pgName: updatedProfile.pgName,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  await ensurePgDoc(updatedProfile);
  await backfillLegacyPgData(pgId, uid);
  return updatedProfile;
}

async function ensurePgDoc(profile) {
  const pgRef = db.collection("pgs").doc(profile.pgId);
  const snapshot = await pgRef.get();
  if (snapshot.exists) return;
  await pgRef.set({
    id: profile.pgId,
    name: profile.pgName || "My PG",
    address: "",
    ownerUid: profile.id,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function backfillLegacyPgData(pgId, adminUid) {
  const pgRef = db.collection("pgs").doc(pgId);
  const pgSnapshot = await pgRef.get();
  if (pgSnapshot.data()?.legacyBackfilled) return;

  const [usersSnapshot, roomsSnapshot, paymentsSnapshot] = await Promise.all([
    db.collection("users").get(),
    db.collection("rooms").get(),
    db.collection("payments").get(),
  ]);

  let batch = db.batch();
  let writes = 0;
  const commitIfNeeded = async () => {
    if (!writes) return;
    await batch.commit();
    batch = db.batch();
    writes = 0;
  };
  const queue = async (ref, data) => {
    batch.set(ref, data, { merge: true });
    writes += 1;
    if (writes >= 450) await commitIfNeeded();
  };

  for (const doc of usersSnapshot.docs) {
    const user = doc.data();
    if (user.pgId) continue;
    if (doc.id === adminUid || user.role === "resident") {
      await queue(doc.ref, { pgId, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    }
  }

  for (const doc of roomsSnapshot.docs) {
    if (!doc.data().pgId) await queue(doc.ref, { pgId, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  }

  for (const doc of paymentsSnapshot.docs) {
    if (!doc.data().pgId) await queue(doc.ref, { pgId, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  }

  await queue(pgRef, { legacyBackfilled: true, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  await commitIfNeeded();
}

function buildRoom(pgId, roomNumber, floorName, bedCount) {
  return {
    id: roomDocId(pgId, roomNumber),
    pgId,
    number: roomNumber,
    floor: floorName,
    beds: createBedLabels(bedCount),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

function roomDocId(pgId, roomNumber) {
  return `${pgId}_${roomNumber}`.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function createBedLabels(count) {
  return Array.from({ length: count }, (_, index) => `B${index + 1}`);
}

function validateResident(body) {
  const email = clean(body.email).toLowerCase();
  const aadhaar = onlyDigits(body.aadhaar);
  const password = String(body.password || "");
  const dueDay = Number(body.dueDay);
  const resident = {
    name: clean(body.name),
    email,
    phone: clean(body.phone),
    aadhaar,
    address: clean(body.address),
    room: clean(body.room).toUpperCase(),
    bed: clean(body.bed).toUpperCase(),
    rent: Number(body.rent),
    deposit: Number(body.deposit),
    joiningDate: clean(body.joiningDate),
    dueDay,
  };

  if (!email.endsWith("@gmail.com")) throw httpError(400, "Resident must use a Gmail address.");
  if (password.length < 6) throw httpError(400, "Temporary password must be at least 6 characters.");
  if (aadhaar.length !== 12) throw httpError(400, "Aadhaar must be 12 digits.");
  if (!resident.name || !resident.phone || !resident.room || !resident.bed || !resident.joiningDate) {
    throw httpError(400, "Name, phone, room, bed, and joining date are required.");
  }
  if (!resident.rent || resident.rent < 0 || resident.deposit < 0) throw httpError(400, "Rent and deposit must be valid amounts.");
  if (!dueDay || dueDay < 1 || dueDay > 28) throw httpError(400, "Payment date must be between 1 and 28.");
  return resident;
}

function validateResidentDetails(body) {
  const aadhaar = onlyDigits(body.aadhaar);
  const dueDay = Number(body.dueDay);
  const resident = {
    name: clean(body.name),
    phone: clean(body.phone),
    aadhaar,
    address: clean(body.address),
    room: clean(body.room).toUpperCase(),
    bed: clean(body.bed).toUpperCase(),
    rent: Number(body.rent),
    deposit: Number(body.deposit),
    joiningDate: clean(body.joiningDate),
    dueDay,
  };

  if (aadhaar.length !== 12) throw httpError(400, "Aadhaar must be 12 digits.");
  if (!resident.name || !resident.phone || !resident.room || !resident.bed || !resident.joiningDate) {
    throw httpError(400, "Name, phone, room, bed, and joining date are required.");
  }
  if (!resident.rent || resident.rent < 0 || resident.deposit < 0) throw httpError(400, "Rent and deposit must be valid amounts.");
  if (!dueDay || dueDay < 1 || dueDay > 28) throw httpError(400, "Payment date must be between 1 and 28.");
  return resident;
}

function validatePaymentProof(proof) {
  if (!proof) return null;
  const dataUrl = clean(proof.dataUrl);
  if (!dataUrl) return null;
  if (!dataUrl.startsWith("data:image/jpeg;base64,")) throw httpError(400, "Payment screenshot must be a JPG image.");
  if (dataUrl.length > 900000) throw httpError(400, "Payment screenshot is too large.");
  return {
    name: clean(proof.name).slice(0, 120) || "payment-proof.jpg",
    type: "image/jpeg",
    dataUrl,
  };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function serveStatic(request, response) {
  const url = new URL(request.url || "/", `http://${request.headers.host}`);
  const requestedPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = resolve(root, `.${normalize(requestedPath)}`);

  if (!filePath.startsWith(root) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  response.writeHead(200, { "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream" });
  createReadStream(filePath).pipe(response);
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function initializeFirebaseAdmin() {
  if (!projectId) return false;
  if (admin.apps.length) return true;

  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
    : null;

  admin.initializeApp({
    credential: serviceAccount ? admin.credential.cert(serviceAccount) : admin.credential.applicationDefault(),
    projectId,
  });
  return true;
}

function ensureFirebaseReady() {
  if (!firebaseReady) throw httpError(500, "Firebase Admin environment variables are missing.");
}

function getFirebaseClientConfig() {
  return {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId,
    appId: process.env.FIREBASE_APP_ID,
  };
}

function serializeDoc(id, data) {
  return Object.fromEntries(
    Object.entries({ id, ...data }).map(([key, value]) => [
      key,
      value && typeof value.toDate === "function" ? value.toDate().toISOString() : value,
    ])
  );
}

function getMonthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function getIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function clean(value) {
  return String(value || "").trim();
}

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}


