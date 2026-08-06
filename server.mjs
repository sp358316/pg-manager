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

  const removeMatch = url.pathname.match(/^\/api\/admin\/residents\/([^/]+)\/remove$/);
  if (request.method === "POST" && removeMatch) {
    await requireAdmin(request);
    await db.collection("users").doc(removeMatch[1]).set(
      {
        status: "left",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    sendJson(response, 200, { ok: true });
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
    await requireAdmin(request);
    await reviewPayment(paymentMatch[1], paymentMatch[2]);
    sendJson(response, 200, { ok: true });
    return;
  }

  sendJson(response, 404, { error: "API route not found." });
}

async function createResident(body) {
  const resident = validateResident(body);
  const bedTaken = await isBedTaken(resident.room, resident.bed);
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
    role: "resident",
    status: "active",
    ...resident,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await db.collection("users").doc(authUser.uid).set(profile);
  await ensureRoom(resident.room, resident.bed);
  return { ...profile, createdAt: null, updatedAt: null };
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

  if (!amount || amount < 1) throw httpError(400, "Payment amount is required.");
  if (!method || !transactionId || !paidOn) throw httpError(400, "Payment method, transaction ID, and date are required.");

  const existing = await db
    .collection("payments")
    .where("residentId", "==", profile.id)
    .where("month", "==", month)
    .where("status", "==", "pending")
    .get();
  if (!existing.empty) throw httpError(409, "You already have a payment waiting for admin approval.");

  const paymentRef = db.collection("payments").doc();
  const payment = {
    id: paymentRef.id,
    residentId: profile.id,
    residentEmail: profile.email,
    month,
    amount,
    method,
    transactionId,
    paidOn,
    status: "pending",
    note: clean(body.note),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  await paymentRef.set(payment);
  return { ...payment, createdAt: null, updatedAt: null };
}

async function reviewPayment(paymentId, action) {
  const paymentRef = db.collection("payments").doc(paymentId);
  const snapshot = await paymentRef.get();
  if (!snapshot.exists) throw httpError(404, "Payment not found.");
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
  const [usersSnapshot, roomsSnapshot, paymentsSnapshot] = await Promise.all([
    db.collection("users").get(),
    db.collection("rooms").get(),
    db.collection("payments").get(),
  ]);

  return {
    profile: serializeDoc(profile.id, profile),
    users: usersSnapshot.docs.map((doc) => serializeDoc(doc.id, doc.data())),
    rooms: roomsSnapshot.docs.map((doc) => serializeDoc(doc.id, doc.data())),
    payments: paymentsSnapshot.docs.map((doc) => serializeDoc(doc.id, doc.data())),
  };
}

async function getResidentBootstrap(profile) {
  const paymentsSnapshot = await db.collection("payments").where("residentId", "==", profile.id).get();
  return {
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
  return {
    auth: decoded,
    profile: { id: profileSnapshot.id, ...profileSnapshot.data() },
  };
}

async function isBedTaken(room, bed) {
  const snapshot = await db
    .collection("users")
    .where("role", "==", "resident")
    .where("status", "==", "active")
    .where("room", "==", room)
    .where("bed", "==", bed)
    .get();
  return !snapshot.empty;
}

async function ensureRoom(room, bed) {
  const ref = db.collection("rooms").doc(room);
  const snapshot = await ref.get();
  if (!snapshot.exists) {
    await ref.set({
      id: room,
      number: room,
      beds: [bed],
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return;
  }

  await ref.set(
    {
      beds: admin.firestore.FieldValue.arrayUnion(bed),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
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


