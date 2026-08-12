import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

const monthKey = getMonthKey(new Date());

let firebaseApp;
let auth;
let currentUser = null;
let state = { pg: null, profile: null, users: [], rooms: [], payments: [], pgs: [], owners: [] };
let searchTerm = "";
let selectedProperty = { floor: null, room: null, bed: null };
let activeAdminModule = "dashboard";
let activeSuperModule = "platform-dashboard";
const mobileSectionsQuery = window.matchMedia("(max-width: 760px)");
const adminModules = new Set(["dashboard", "admissions", "property", "residents", "payments", "documents", "reports", "settings"]);
const superModules = new Set(["platform-dashboard", "pg-owners", "plans", "platform-settings"]);

const authScreen = document.querySelector("#authScreen");
const appShell = document.querySelector("#appShell");
const superView = document.querySelector("#superView");
const adminView = document.querySelector("#adminView");
const residentView = document.querySelector("#residentView");
const superNav = document.querySelector("#superNav");
const adminNav = document.querySelector("#adminNav");
const residentNav = document.querySelector("#residentNav");
const emptyTemplate = document.querySelector("#emptyStateTemplate");
const toast = document.querySelector("#toast");
const proofModal = document.querySelector("#proofModal");
const proofModalImage = document.querySelector("#proofModalImage");
const proofModalTitle = document.querySelector("#proofModalTitle");
const proofModalDownload = document.querySelector("#proofModalDownload");

document.querySelector("#todayLabel").textContent = new Intl.DateTimeFormat("en-IN", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
}).format(new Date());

document.querySelector("#manualResidentForm").joiningDate.valueAsDate = new Date();
document.querySelector("#paymentForm").paidOn.valueAsDate = new Date();
document.querySelector("#paymentMethodSelect").addEventListener("change", renderPaymentInstructions);

document.querySelector("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  await withButtonLock(form.querySelector("button[type='submit']"), "Logging in...", async () => {
    await signInWithEmailAndPassword(auth, normalizeEmail(data.get("email")), data.get("password"));
  });
});

document.querySelector("#forgotPasswordButton").addEventListener("click", async () => {
  const email = normalizeEmail(document.querySelector("#loginForm").email.value);
  if (!email) {
    showToast("Enter your Gmail first, then click forgot password.", "error");
    return;
  }

  try {
    await sendPasswordResetEmail(auth, email);
    showToast("Password reset email sent. Please check Gmail.");
  } catch (error) {
    showToast(getFriendlyError(error), "error");
  }
});

document.querySelector("#logoutButton").addEventListener("click", async () => {
  await signOut(auth);
});

document.querySelector("#manualResidentForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  await withButtonLock(form.querySelector("button[type='submit']"), "Creating...", async () => {
    await api("/api/admin/residents", {
      method: "POST",
      body: formToJson(form),
    });
    form.reset();
    form.joiningDate.valueAsDate = new Date();
    form.dueDay.value = 5;
    await loadPortal();
    showToast("Resident account created. Share the temporary password.");
  });
});

document.querySelector("#floorSetupForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  await withButtonLock(form.querySelector("button[type='submit']"), "Creating floor...", async () => {
    await api("/api/admin/property/floors", {
      method: "POST",
      body: formToJson(form),
    });
    form.reset();
    form.floorCount.value = 1;
    form.bedsPerRoom.value = 6;
    await loadPortal();
    showToast("Floor, rooms, and beds created.");
  });
});

document.querySelector("#roomSetupForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  await withButtonLock(form.querySelector("button[type='submit']"), "Saving room...", async () => {
    await api("/api/admin/property/rooms", {
      method: "POST",
      body: formToJson(form),
    });
    form.reset();
    form.bedCount.value = 6;
    await loadPortal();
    showToast("Room bed count saved.");
  });
});

document.querySelector("#pgSettingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  await withButtonLock(form.querySelector("button[type='submit']"), "Saving PG...", async () => {
    await api("/api/admin/pg", {
      method: "POST",
      body: formToJson(form),
    });
    await loadPortal();
    showToast("PG information saved.");
  });
});

document.querySelector("#pgOwnerForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  await withButtonLock(form.querySelector("button[type='submit']"), "Creating owner...", async () => {
    await api("/api/super/pg-owners", {
      method: "POST",
      body: formToJson(form),
    });
    form.reset();
    form.plan.value = "free";
    form.status.value = "active";
    form.subscriptionStatus.value = "trial";
    await loadPortal();
    showToast("PG owner account created. Share the temporary password.");
  });
});

document.querySelector("#clearForm").addEventListener("click", () => {
  const form = document.querySelector("#manualResidentForm");
  form.reset();
  form.joiningDate.valueAsDate = new Date();
  form.dueDay.value = 5;
  renderResidentBedOptions();
});

document.querySelector("#residentRoomSelect").addEventListener("change", () => {
  renderResidentBedOptions();
});

document.querySelector("#editResidentRoomSelect").addEventListener("change", () => {
  renderEditResidentBedOptions();
});

document.querySelector("#searchInput").addEventListener("input", (event) => {
  searchTerm = event.target.value.toLowerCase();
  renderResidents();
});

document.querySelector("#residentRows").addEventListener("click", async (event) => {
  const editButton = event.target.closest("button[data-edit]");
  if (editButton) {
    openEditResident(editButton.dataset.edit);
    return;
  }

  const button = event.target.closest("button[data-remove]");
  if (!button) return;
  const user = state.users.find((item) => item.id === button.dataset.remove);
  if (!user || !confirm(`Mark ${user.name} as left?`)) return;

  await withButtonLock(button, "Removing...", async () => {
    await api(`/api/admin/residents/${user.id}/remove`, { method: "POST" });
    await loadPortal();
    showToast("Resident removed from active list.");
  });
});

document.querySelector("#editResidentForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const residentId = form.residentId.value;
  await withButtonLock(form.querySelector("button[type='submit']"), "Saving...", async () => {
    await api(`/api/admin/residents/${residentId}/update`, {
      method: "POST",
      body: formToJson(form),
    });
    closeEditResident();
    await loadPortal();
    showToast("Resident details updated.");
  });
});

document.querySelector("#cancelEditResident").addEventListener("click", () => {
  closeEditResident();
});

document.addEventListener("click", (event) => {
  const proofButton = event.target.closest("[data-payment-proof]");
  if (!proofButton) return;
  openPaymentProof(proofButton.dataset.paymentProof);
});

document.querySelector("#proofModalClose").addEventListener("click", () => {
  closePaymentProof();
});

proofModal.addEventListener("click", (event) => {
  if (event.target === proofModal) closePaymentProof();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !proofModal.classList.contains("hidden")) {
    closePaymentProof();
  }
});

document.querySelector("#approvalList").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-payment-action]");
  if (!button) return;
  const action = button.dataset.paymentAction;
  await withButtonLock(button, action === "approve" ? "Approving..." : "Rejecting...", async () => {
    await api(`/api/payments/${button.dataset.paymentId}/${action}`, { method: "POST" });
    await loadPortal();
    showToast(`Payment ${action === "approve" ? "approved" : "rejected"}.`);
  });
});

document.querySelector("#propertyFlow").addEventListener("click", (event) => {
  const target = event.target.closest("[data-flow-type]");
  if (!target) return;

  selectPropertyFlow(target);
});

document.querySelector("#propertyFlow").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const target = event.target.closest("[data-flow-type]");
  if (!target) return;
  event.preventDefault();
  selectPropertyFlow(target);
});

document.querySelector("#notifyButton").addEventListener("click", () => {
  const dueResidents = getActiveResidents().filter(isPaymentDue);
  if (!dueResidents.length) {
    showToast("All active residents are paid or awaiting approval for this month.");
    return;
  }

  alert(
    `Send reminders to ${dueResidents.length} resident(s):\n\n${dueResidents
      .map((resident) => `${resident.name} - ${resident.room}/${resident.bed} - Rs ${formatNumber(resident.rent)}`)
      .join("\n")}`
  );
});

document.querySelector("#paymentForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  await withButtonLock(form.querySelector("button[type='submit']"), "Submitting...", async () => {
    const body = formToJson(form);
    body.proofImage = await buildPaymentProof(form.proofImage.files[0]);
    await api("/api/payments", {
      method: "POST",
      body,
    });
    form.reset();
    form.paidOn.valueAsDate = new Date();
    await loadPortal();
    showToast("Payment submitted. Admin will validate and approve it manually.");
  });
});

document.querySelector("#adminView").addEventListener("click", (event) => {
  const moduleLink = event.target.closest("[data-admin-module-link]");
  if (moduleLink) {
    setAdminModule(moduleLink.dataset.adminModuleLink, true);
    return;
  }

  const dashboardLink = event.target.closest("[data-admin-dashboard-link]");
  if (dashboardLink) {
    setAdminModule("dashboard", true);
    return;
  }

  const toggle = event.target.closest("[data-mobile-section-toggle]");
  const heading = event.target.closest("[data-mobile-section-header]");
  if (!toggle && !heading) return;
  if (!mobileSectionsQuery.matches) return;
  if (!toggle && event.target.closest("button, input, select, textarea, a")) return;

  const panel = (toggle || heading).closest(".mobile-section");
  if (!panel) return;
  setMobileSectionOpen(panel, panel.classList.contains("is-collapsed"), true);
});

document.querySelector("#adminView").addEventListener("keydown", (event) => {
  if (!mobileSectionsQuery.matches || !["Enter", " "].includes(event.key)) return;
  const heading = event.target.closest("[data-mobile-section-header]");
  if (!heading) return;
  if (event.target.closest("button, input, select, textarea, a")) return;
  event.preventDefault();
  const panel = heading.closest(".mobile-section");
  if (panel) setMobileSectionOpen(panel, panel.classList.contains("is-collapsed"), true);
});

document.querySelector("#adminNav").addEventListener("click", (event) => {
  const link = event.target.closest("[data-admin-module-link]");
  if (!link) return;
  event.preventDefault();
  setAdminModule(link.dataset.adminModuleLink, true);
});

document.querySelector("#superNav").addEventListener("click", (event) => {
  const link = event.target.closest("[data-super-module-link]");
  if (!link) return;
  event.preventDefault();
  setSuperModule(link.dataset.superModuleLink, true);
});

document.querySelector("#superView").addEventListener("click", async (event) => {
  const moduleLink = event.target.closest("[data-super-module-link]");
  if (moduleLink) {
    setSuperModule(moduleLink.dataset.superModuleLink, true);
    return;
  }

  const dashboardLink = event.target.closest("[data-super-dashboard-link]");
  if (dashboardLink) {
    setSuperModule("platform-dashboard", true);
    return;
  }

  const updateButton = event.target.closest("[data-update-owner]");
  if (!updateButton) return;
  const card = updateButton.closest("[data-owner-card]");
  const ownerId = updateButton.dataset.updateOwner;
  await withButtonLock(updateButton, "Saving...", async () => {
    await api(`/api/super/pg-owners/${ownerId}/update`, {
      method: "POST",
      body: formToJson(card),
    });
    await loadPortal();
    showToast("PG owner updated.");
  });
});

window.addEventListener("hashchange", () => {
  if (state.profile?.role === "admin") {
    setAdminModule(getModuleFromHash(), false);
  }
  if (state.profile?.role === "super_admin") {
    setSuperModule(getSuperModuleFromHash(), false);
  }
});

mobileSectionsQuery.addEventListener("change", () => {
  setupMobileSections();
});

await boot();

async function boot() {
  try {
    const configResponse = await fetch("/api/firebase-config");
    if (!configResponse.ok) throw new Error("Firebase client config is missing.");
    firebaseApp = initializeApp(await configResponse.json());
    auth = getAuth(firebaseApp);
  } catch (error) {
    showSetupError(error.message);
    return;
  }

  onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    if (!user) {
      state = { pg: null, profile: null, users: [], rooms: [], payments: [], pgs: [], owners: [] };
      renderLoggedOut();
      return;
    }

    try {
      await loadPortal();
    } catch (error) {
      showToast(getFriendlyError(error), "error");
      await signOut(auth);
    }
  });
}

async function loadPortal() {
  state = await api("/api/bootstrap");
  syncSelectedProperty();
  renderPortal();
}

function renderLoggedOut() {
  authScreen.classList.remove("hidden");
  appShell.classList.add("hidden");
  document.querySelector("#loginForm").reset();
}

function renderPortal() {
  const profile = state.profile;
  if (!profile) {
    renderLoggedOut();
    return;
  }

  authScreen.classList.add("hidden");
  appShell.classList.remove("hidden");
  document.querySelector("#signedInName").textContent = profile.name || currentUser.email;
  document.querySelector("#signedInEmail").textContent = currentUser.email;
  document.querySelector("#portalPgName").textContent = state.pg?.name || profile.pgName || "PG Manager";

  const isSuperAdmin = profile.role === "super_admin";
  const isAdmin = profile.role === "admin";
  document.querySelector("#roleLabel").textContent = isSuperAdmin ? "Super Admin" : isAdmin ? "Admin portal" : "Resident portal";
  superView.classList.toggle("hidden", !isSuperAdmin);
  adminView.classList.toggle("hidden", !isAdmin);
  residentView.classList.toggle("hidden", isAdmin || isSuperAdmin);
  superNav.classList.toggle("hidden", !isSuperAdmin);
  adminNav.classList.toggle("hidden", !isAdmin);
  residentNav.classList.toggle("hidden", isAdmin || isSuperAdmin);

  if (isSuperAdmin) {
    activeSuperModule = getSuperModuleFromHash();
    renderSuperAdmin();
  } else if (isAdmin) {
    activeAdminModule = getModuleFromHash();
    renderAdmin();
  } else {
    renderResident();
  }
}

function renderSuperAdmin() {
  renderSuperStats();
  renderPgOwners();
  renderSuperModuleView();
}

function renderSuperStats() {
  const owners = state.owners || [];
  const activeOwners = owners.filter((owner) => owner.status === "active" && !["suspended", "cancelled"].includes(owner.subscriptionStatus));
  const suspended = owners.filter((owner) => owner.status !== "active" || ["suspended", "cancelled"].includes(owner.subscriptionStatus));
  const residents = state.users.filter((user) => user.role === "resident");

  document.querySelector("#superTotalPgs").textContent = state.pgs.length;
  document.querySelector("#superActiveOwners").textContent = activeOwners.length;
  document.querySelector("#superSuspendedPgs").textContent = suspended.length;
  document.querySelector("#superTotalResidents").textContent = residents.length;
}

function renderPgOwners() {
  const list = document.querySelector("#pgOwnerList");
  list.replaceChildren();
  if (!state.owners.length) {
    list.append(emptyNotice("No PG owners yet", "Create a PG owner account to start onboarding PGs."));
    return;
  }

  state.owners
    .slice()
    .sort((a, b) => a.pgName.localeCompare(b.pgName, undefined, { numeric: true }))
    .forEach((owner) => {
      const card = document.createElement("form");
      card.className = "detail-card owner-management-card";
      card.dataset.ownerCard = owner.id;
      card.innerHTML = `
        <div class="detail-card-head">
          <div>
            <strong>${escapeHtml(owner.pgName)}</strong>
            <p>${escapeHtml(owner.name)} - ${escapeHtml(owner.email)}</p>
          </div>
          <span class="status-pill ${owner.status === "active" && !["suspended", "cancelled"].includes(owner.subscriptionStatus) ? "paid" : "due"}">${escapeHtml(
        owner.subscriptionStatus
      )}</span>
        </div>
        <div class="form-grid compact">
          <label>Owner name <input name="name" type="text" value="${escapeAttr(owner.name)}" required /></label>
          <label>Phone <input name="phone" type="tel" value="${escapeAttr(owner.phone)}" /></label>
          <label>PG name <input name="pgName" type="text" value="${escapeAttr(owner.pgName)}" required /></label>
          <label>Plan
            <select name="plan">
              ${optionHtml("free", "Free", owner.plan)}
              ${optionHtml("basic", "Basic", owner.plan)}
              ${optionHtml("premium", "Premium", owner.plan)}
            </select>
          </label>
          <label>Status
            <select name="status">
              ${optionHtml("active", "Active", owner.status)}
              ${optionHtml("inactive", "Inactive", owner.status)}
            </select>
          </label>
          <label>Subscription
            <select name="subscriptionStatus">
              ${optionHtml("trial", "Trial", owner.subscriptionStatus)}
              ${optionHtml("active", "Active", owner.subscriptionStatus)}
              ${optionHtml("suspended", "Suspended", owner.subscriptionStatus)}
              ${optionHtml("cancelled", "Cancelled", owner.subscriptionStatus)}
            </select>
          </label>
          <label class="wide">PG address <textarea name="pgAddress" rows="2">${escapeHtml(owner.pgAddress)}</textarea></label>
        </div>
        <button class="secondary-action full" type="button" data-update-owner="${owner.id}">Save owner changes</button>
      `;
      list.append(card);
    });
}

function getSuperModuleFromHash() {
  const hash = window.location.hash.replace("#", "");
  return superModules.has(hash) ? hash : "platform-dashboard";
}

function setSuperModule(moduleName, updateHash = false) {
  activeSuperModule = superModules.has(moduleName) ? moduleName : "platform-dashboard";
  renderSuperModuleView();

  if (updateHash && window.location.hash !== `#${activeSuperModule}`) {
    window.location.hash = activeSuperModule;
  }

  if (state.profile?.role === "super_admin") {
    superView.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function renderSuperModuleView() {
  document.querySelectorAll("[data-super-module]").forEach((view) => {
    view.classList.toggle("hidden", view.dataset.superModule !== activeSuperModule);
  });

  document.querySelectorAll("[data-super-module-link]").forEach((link) => {
    link.classList.toggle("active", link.dataset.superModuleLink === activeSuperModule);
  });
}

function renderAdmin() {
  renderAdminStats();
  renderPropertyForms();
  renderPropertyFlow();
  renderNotifications();
  renderResidents();
  renderApprovals();
  renderRooms();
  renderDocuments();
  renderReports();
  renderAdminPayments();
  renderPgSettings();
  renderAdminModuleView();
  setupMobileSections();
}

function renderPgSettings() {
  const form = document.querySelector("#pgSettingsForm");
  const settings = state.pg?.paymentSettings || {};
  form.name.value = state.pg?.name || state.profile?.pgName || "My PG";
  form.address.value = state.pg?.address || "";
  form.allowUpi.checked = Boolean(settings.allowUpi);
  form.upiId.value = settings.upiId || "";
  form.allowBank.checked = Boolean(settings.allowBank);
  form.bankDetails.value = settings.bankDetails || "";
  form.allowCash.checked = Boolean(settings.allowCash);
  form.cashInstructions.value = settings.cashInstructions || "";
}

function getModuleFromHash() {
  const hash = window.location.hash.replace("#", "");
  return adminModules.has(hash) ? hash : "dashboard";
}

function setAdminModule(moduleName, updateHash = false) {
  activeAdminModule = adminModules.has(moduleName) ? moduleName : "dashboard";
  renderAdminModuleView();

  if (updateHash && window.location.hash !== `#${activeAdminModule}`) {
    window.location.hash = activeAdminModule;
  }

  if (state.profile?.role === "admin") {
    adminView.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function renderAdminModuleView() {
  document.querySelectorAll("[data-admin-module]").forEach((view) => {
    view.classList.toggle("hidden", view.dataset.adminModule !== activeAdminModule);
  });

  document.querySelectorAll("[data-admin-module-link]").forEach((link) => {
    link.classList.toggle("active", link.dataset.adminModuleLink === activeAdminModule);
  });
}

function renderPropertyForms() {
  const floorInput = document.querySelector("#roomFloorName");
  if (!floorInput.value) floorInput.value = getFloors()[0]?.name || "Floor 1";
  renderResidentRoomOptions();
}

function renderAdminStats() {
  const activeResidents = getActiveResidents();
  const approvedPayments = state.payments.filter((payment) => payment.month === monthKey && payment.status === "approved");
  const pendingPayments = state.payments.filter((payment) => payment.status === "pending").length;
  const bedCount = state.rooms.reduce((sum, room) => sum + room.beds.length, 0);
  const occupiedRooms = new Set(activeResidents.map((resident) => resident.room));
  const approvedCollection = approvedPayments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0);

  document.querySelector("#totalResidents").textContent = activeResidents.length;
  document.querySelector("#roomsOccupied").textContent = occupiedRooms.size;
  document.querySelector("#roomCapacity").textContent = `${activeResidents.length} of ${bedCount} beds occupied`;
  document.querySelector("#pendingApprovals").textContent = pendingPayments;
  document.querySelector("#monthlyCollection").textContent = `Rs ${formatNumber(approvedCollection)}`;
}

function renderNotifications() {
  const list = document.querySelector("#notificationList");
  list.replaceChildren();
  const dueResidents = getActiveResidents().filter(isPaymentDue);
  if (!dueResidents.length) {
    list.append(emptyNotice("No reminders pending", "All active residents are paid, awaiting approval, or not due yet."));
    return;
  }

  dueResidents.forEach((resident) => {
    const item = document.createElement("article");
    item.className = "detail-card";
    item.innerHTML = `
      <div class="detail-card-head">
        <div>
          <strong>${escapeHtml(resident.name)}</strong>
          <p>Room ${escapeHtml(resident.room)} / ${escapeHtml(resident.bed)} - rent due every month on ${formatOrdinalDay(resident.dueDay)}</p>
        </div>
        <span class="amount">Rs ${formatNumber(resident.rent)}</span>
      </div>
    `;
    list.append(item);
  });
}

function renderResidents() {
  const body = document.querySelector("#residentRows");
  body.replaceChildren();
  const filtered = getActiveResidents().filter((resident) => {
    const searchable = `${resident.name} ${resident.email} ${resident.room} ${resident.phone}`.toLowerCase();
    return searchable.includes(searchTerm);
  });

  if (!filtered.length) {
    const row = document.createElement("tr");
    row.innerHTML = `<td colspan="8"></td>`;
    row.querySelector("td").append(emptyTemplate.content.cloneNode(true));
    body.append(row);
    return;
  }

  filtered.forEach((resident) => {
    const status = getResidentPaymentStatus(resident);
    const row = document.createElement("tr");
    row.innerHTML = `
      <td data-label="Name"><strong>${escapeHtml(resident.name)}</strong><br /><small>${escapeHtml(resident.email)}</small></td>
      <td data-label="Room">${escapeHtml(resident.room)} / ${escapeHtml(resident.bed)}<br /><small>Joined ${formatDate(resident.joiningDate)}</small></td>
      <td data-label="Phone">${escapeHtml(resident.phone)}</td>
      <td data-label="Aadhaar">${maskAadhaar(resident.aadhaar)}</td>
      <td data-label="Rent">Rs ${formatNumber(resident.rent)}<br /><small>Every month: ${formatOrdinalDay(resident.dueDay)}</small></td>
      <td data-label="Deposit">Rs ${formatNumber(resident.deposit)}</td>
      <td data-label="Status"><span class="status-pill ${status.className}">${status.label}</span></td>
      <td data-label="Action">
        <div class="row-actions">
          <button class="small-button" type="button" data-edit="${resident.id}">Edit</button>
          <button class="danger-button" type="button" data-remove="${resident.id}">Remove</button>
        </div>
      </td>
    `;
    body.append(row);
  });
}

function renderApprovals() {
  const list = document.querySelector("#approvalList");
  list.replaceChildren();
  const pending = state.payments.filter((payment) => payment.status === "pending");

  if (!pending.length) {
    list.append(emptyNotice("No payment approvals", "Resident payment submissions will appear here."));
    return;
  }

  pending.forEach((payment) => {
    const resident = state.users.find((user) => user.id === payment.residentId);
    const card = document.createElement("article");
    card.className = "detail-card";
    card.innerHTML = `
      <div class="detail-card-head">
        <div>
          <strong>${escapeHtml(resident?.name || "Unknown resident")}</strong>
          <p>${escapeHtml(payment.method)} - ${escapeHtml(payment.transactionId)} - ${formatDate(payment.paidOn)}</p>
        </div>
        <span class="amount">Rs ${formatNumber(payment.amount)}</span>
      </div>
      <p class="muted-text">${escapeHtml(payment.note || "No note added.")}</p>
      <div class="row-actions">
        ${payment.proofImage?.dataUrl ? `<button class="small-link-button" type="button" data-payment-proof="${payment.id}">View screenshot</button>` : ""}
        <button class="small-button" type="button" data-payment-action="approve" data-payment-id="${payment.id}">Approve payment</button>
        <button class="danger-button" type="button" data-payment-action="reject" data-payment-id="${payment.id}">Reject</button>
      </div>
    `;
    list.append(card);
  });
}

function renderRooms() {
  const grid = document.querySelector("#roomGrid");
  grid.replaceChildren();
  if (!state.rooms.length) {
    grid.append(emptyNotice("No rooms yet", "Rooms are created automatically when the admin adds residents."));
    return;
  }

  state.rooms
    .slice()
    .sort((a, b) => a.number.localeCompare(b.number))
    .forEach((room) => {
      const card = document.createElement("article");
      card.className = "room-card";
      const occupied = room.beds.filter((bed) => isBedTaken(room.number, bed));
      const occupancyPercent = room.beds.length ? Math.round((occupied.length / room.beds.length) * 100) : 0;
      const occupiedDetails = occupied
        .map((bed) => {
          const resident = getActiveResidents().find((item) => item.room === room.number && item.bed === bed);
          return `<span class="bed-chip occupied">${escapeHtml(bed)} - ${escapeHtml(resident?.name || "occupied")}</span>`;
        })
        .join("");
      card.innerHTML = `
        <div class="room-card-head">
          <div>
            <strong>Room ${escapeHtml(room.number)}</strong>
            <p>${escapeHtml(room.floor || getFloorName(room.number))}</p>
          </div>
          <span class="room-count">${occupied.length}/${room.beds.length}</span>
        </div>
        <div class="occupancy-meter" aria-label="${occupied.length} of ${room.beds.length} beds occupied">
          <span style="width: ${occupancyPercent}%"></span>
        </div>
        <div class="room-beds">
          ${occupiedDetails || `<span class="bed-chip">All beds vacant</span>`}
          ${room.beds.length - occupied.length > 0 ? `<span class="bed-chip vacant-count">${room.beds.length - occupied.length} vacant</span>` : ""}
        </div>
      `;
      grid.append(card);
    });
}

function renderResidentRoomOptions() {
  const roomSelect = document.querySelector("#residentRoomSelect");
  renderRoomOptions(roomSelect, document.querySelector("#residentBedSelect"), roomSelect.value);
}

function renderResidentBedOptions() {
  renderBedOptions(document.querySelector("#residentRoomSelect"), document.querySelector("#residentBedSelect"));
}

function renderEditResidentRoomOptions(resident) {
  renderRoomOptions(
    document.querySelector("#editResidentRoomSelect"),
    document.querySelector("#editResidentBedSelect"),
    resident.room,
    resident.id
  );
  renderEditResidentBedOptions(resident);
}

function renderEditResidentBedOptions(resident = getEditingResident()) {
  renderBedOptions(
    document.querySelector("#editResidentRoomSelect"),
    document.querySelector("#editResidentBedSelect"),
    resident?.bed || "",
    resident?.id || null
  );
}

function renderRoomOptions(roomSelect, bedSelect, selectedRoom = "", residentId = null) {
  roomSelect.replaceChildren();

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = state.rooms.length ? "Select room" : "Create rooms first";
  roomSelect.append(placeholder);

  state.rooms
    .slice()
    .sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }))
    .forEach((room) => {
      const option = document.createElement("option");
      const occupied = getOccupiedBeds(room).length;
      option.value = room.number;
      option.textContent = `${room.floor || getFloorName(room.number)} / Room ${room.number} (${occupied}/${room.beds.length})`;
      option.disabled = occupied >= room.beds.length && !roomHasResident(room, residentId);
      roomSelect.append(option);
    });

  if ([...roomSelect.options].some((option) => option.value === selectedRoom && !option.disabled)) {
    roomSelect.value = selectedRoom;
  }

  renderBedOptions(roomSelect, bedSelect, "", residentId);
}

function renderBedOptions(roomSelect, bedSelect, selectedBed = bedSelect.value, residentId = null) {
  const room = state.rooms.find((item) => item.number === roomSelect.value);
  bedSelect.replaceChildren();

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = room ? "Select bed" : "Select room first";
  bedSelect.append(placeholder);

  if (!room) return;

  room.beds.forEach((bed) => {
    const resident = findResidentByBed(room.number, bed);
    const option = document.createElement("option");
    option.value = bed;
    option.textContent = resident ? `${bed} - occupied by ${resident.name}` : `${bed} - vacant`;
    option.disabled = Boolean(resident && resident.id !== residentId);
    bedSelect.append(option);
  });

  if ([...bedSelect.options].some((option) => option.value === selectedBed && !option.disabled)) {
    bedSelect.value = selectedBed;
  }
}

function openEditResident(residentId) {
  const resident = state.users.find((item) => item.id === residentId);
  if (!resident) return;
  setAdminModule("residents", true);

  const form = document.querySelector("#editResidentForm");
  form.classList.remove("hidden");
  form.residentId.value = resident.id;
  form.name.value = resident.name || "";
  form.phone.value = resident.phone || "";
  form.aadhaar.value = resident.aadhaar || "";
  form.rent.value = resident.rent || "";
  form.deposit.value = resident.deposit ?? 0;
  form.joiningDate.value = resident.joiningDate || "";
  form.dueDay.value = resident.dueDay || 5;
  form.address.value = resident.address || "";
  document.querySelector("#editResidentTitle").textContent = `Edit ${resident.name}`;
  renderEditResidentRoomOptions(resident);
  document.querySelector("#residents").scrollIntoView({ behavior: "smooth", block: "start" });
}

function closeEditResident() {
  const form = document.querySelector("#editResidentForm");
  form.reset();
  form.classList.add("hidden");
}

function getEditingResident() {
  const residentId = document.querySelector("#editResidentForm").residentId.value;
  return state.users.find((item) => item.id === residentId);
}

function renderPropertyFlow() {
  const floors = getFloors();
  const selectedFloor = floors.find((floor) => floor.name === selectedProperty.floor) || floors[0];
  const selectedRoom =
    selectedFloor?.rooms.find((room) => room.number === selectedProperty.room) || selectedFloor?.rooms[0];
  const selectedBed = selectedRoom?.beds.includes(selectedProperty.bed) ? selectedProperty.bed : selectedRoom?.beds[0];
  const selectedResident = selectedRoom && selectedBed ? findResidentByBed(selectedRoom.number, selectedBed) : null;

  renderFlowList("#floorList", floors.map((floor) => ({
    title: floor.name,
    meta: `${floor.rooms.length} room${floor.rooms.length === 1 ? "" : "s"}`,
    active: floor === selectedFloor,
    type: "floor",
    value: floor.name,
  })));

  renderFlowList("#floorRoomList", (selectedFloor?.rooms || []).map((room) => ({
    title: `Room ${room.number}`,
    meta: `${getOccupiedBeds(room).length} of ${room.beds.length} beds occupied`,
    active: room === selectedRoom,
    type: "room",
    value: room.number,
  })));

  renderFlowList("#roomBedList", (selectedRoom?.beds || []).map((bed) => ({
    title: bed,
    meta: findResidentByBed(selectedRoom.number, bed)?.name || "Vacant",
    active: bed === selectedBed,
    type: "bed",
    value: bed,
  })));

  const statusGrid = document.querySelector("#bedStatusGrid");
  statusGrid.replaceChildren();
  if (!selectedRoom) {
    statusGrid.append(emptyNotice("No beds yet", "Add residents to build room and bed map."));
  } else {
    selectedRoom.beds.forEach((bed) => {
      const resident = findResidentByBed(selectedRoom.number, bed);
      const tile = document.createElement("article");
      tile.className = `bed-status-tile ${resident ? "occupied" : "vacant"} ${bed === selectedBed ? "active" : ""}`;
      tile.dataset.flowType = "bed";
      tile.dataset.value = bed;
      tile.innerHTML = `<strong>${escapeHtml(bed)}</strong><span>${resident ? "Occupied" : "Vacant"}</span>`;
      statusGrid.append(tile);
    });
  }

  const guestCard = document.querySelector("#guestDetailsCard");
  if (!selectedResident) {
    guestCard.innerHTML = `
      <strong>No guest selected</strong>
      <p>Select an occupied bed to view guest details.</p>
    `;
    return;
  }

  guestCard.innerHTML = `
    <strong>${escapeHtml(selectedResident.name)}</strong>
    <p>Mobile: ${escapeHtml(selectedResident.phone || "-")}</p>
    <p>Check-in: ${formatDate(selectedResident.joiningDate)}</p>
    <p>Rent: Rs ${formatNumber(selectedResident.rent)}</p>
    <p>Documents: Aadhaar ${selectedResident.aadhaar ? "added" : "pending"}</p>
    <a class="inline-action" href="#residents">View profile</a>
  `;
}

function renderFlowList(selector, items) {
  const list = document.querySelector(selector);
  list.replaceChildren();
  if (!items.length) {
    list.append(emptyNotice("Empty", "No records found."));
    return;
  }

  items.forEach((item) => {
    const row = document.createElement("article");
    row.className = `flow-item ${item.active ? "active" : ""}`;
    row.dataset.flowType = item.type;
    row.dataset.value = item.value;
    row.tabIndex = 0;
    row.innerHTML = `<strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.meta)}</span>`;
    list.append(row);
  });
}

function selectPropertyFlow(target) {
  const { flowType, value } = target.dataset;
  if (flowType === "floor") {
    selectedProperty = { floor: value, room: null, bed: null };
  }
  if (flowType === "room") {
    selectedProperty = { ...selectedProperty, room: value, bed: null };
  }
  if (flowType === "bed") {
    selectedProperty = { ...selectedProperty, bed: value };
  }

  syncSelectedProperty();
  renderPropertyFlow();
}

function renderDocuments() {
  const list = document.querySelector("#documentList");
  list.replaceChildren();
  const residents = getActiveResidents();
  if (!residents.length) {
    list.append(emptyNotice("No documents", "Aadhaar and ID proof status will appear after admission."));
    return;
  }

  residents.slice(0, 6).forEach((resident) => {
    const card = document.createElement("article");
    card.className = "detail-card";
    card.innerHTML = `
      <div class="detail-card-head">
        <div>
          <strong>${escapeHtml(resident.name)}</strong>
          <p>Aadhaar: ${maskAadhaar(resident.aadhaar)} - Address proof: ${resident.address ? "Added" : "Pending"}</p>
        </div>
        <span class="status-pill ${resident.aadhaar ? "paid" : "due"}">${resident.aadhaar ? "Verified" : "Missing"}</span>
      </div>
    `;
    list.append(card);
  });
}

function renderReports() {
  const list = document.querySelector("#reportList");
  list.replaceChildren();
  const residents = getActiveResidents();
  const totalBeds = state.rooms.reduce((sum, room) => sum + room.beds.length, 0);
  const pending = state.payments.filter((payment) => payment.status === "pending").length;
  const approvedCollection = state.payments
    .filter((payment) => payment.month === monthKey && payment.status === "approved")
    .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  const expectedRent = residents.reduce((sum, resident) => sum + Number(resident.rent || 0), 0);
  const dueCount = residents.filter(isPaymentDue).length;

  [
    ["Occupancy overview", `${residents.length} occupied beds out of ${totalBeds}`],
    ["Rent collection report", `Rs ${formatNumber(approvedCollection)} collected this month`],
    ["Due payments report", `${dueCount} residents need reminder`],
    ["Pending approvals", `${pending} payment requests waiting`],
    ["Monthly expected rent", `Rs ${formatNumber(expectedRent)}`],
  ].forEach(([title, body]) => {
    const item = document.createElement("article");
    item.className = "report-item";
    item.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(body)}</span>`;
    list.append(item);
  });
}

function renderAdminPayments() {
  const list = document.querySelector("#adminPaymentList");
  list.replaceChildren();
  if (!state.payments.length) {
    list.append(emptyNotice("No payments submitted", "Resident payment records and screenshots will appear here."));
    return;
  }

  state.payments
    .slice()
    .sort((a, b) => String(b.createdAt || b.paidOn || "").localeCompare(String(a.createdAt || a.paidOn || "")))
    .forEach((payment) => {
      const resident = state.users.find((user) => user.id === payment.residentId);
      const card = document.createElement("article");
      card.className = "detail-card";
      card.innerHTML = `
        <div class="detail-card-head">
          <div>
            <strong>${escapeHtml(resident?.name || payment.residentEmail || "Unknown resident")}</strong>
            <p>${escapeHtml(payment.method)} - ${escapeHtml(payment.transactionId)} - ${formatDate(payment.paidOn)}</p>
          </div>
          <span class="status-pill ${payment.status === "approved" ? "paid" : payment.status === "rejected" ? "due" : "waiting"}">${escapeHtml(payment.status)}</span>
        </div>
        <p class="muted-text">Amount: Rs ${formatNumber(payment.amount)}${payment.note ? ` - ${escapeHtml(payment.note)}` : ""}</p>
        <div class="row-actions">
          ${payment.proofImage?.dataUrl ? `<button class="small-link-button" type="button" data-payment-proof="${payment.id}">View screenshot</button>` : `<span class="muted-text">No screenshot attached</span>`}
        </div>
      `;
      list.append(card);
    });
}

function setupMobileSections() {
  const panels = document.querySelectorAll("#adminView .panel");
  panels.forEach((panel) => {
    const heading = panel.querySelector(":scope > .panel-heading, :scope > .table-heading");
    const toggle = heading?.querySelector("[data-mobile-section-toggle]");
    panel.classList.remove("mobile-section", "is-collapsed");
    delete panel.dataset.mobileReady;
    if (heading) {
      delete heading.dataset.mobileSectionHeader;
      heading.removeAttribute("role");
      heading.removeAttribute("tabindex");
      heading.removeAttribute("aria-expanded");
    }
    toggle?.remove();
  });
}

function setMobileSectionOpen(panel, open, closeOthers = false) {
  if (closeOthers && open) {
    document.querySelectorAll("#adminView .mobile-section").forEach((section) => {
      if (section !== panel) {
        section.classList.add("is-collapsed");
        updateMobileSectionState(section);
      }
    });
  }
  panel.classList.toggle("is-collapsed", !open);
  updateMobileSectionState(panel);
}

function updateMobileSectionState(panel) {
  const isOpen = !panel.classList.contains("is-collapsed");
  const heading = panel.querySelector(":scope > .panel-heading, :scope > .table-heading");
  const toggle = panel.querySelector("[data-mobile-section-toggle]");
  heading?.setAttribute("aria-expanded", String(isOpen));
  if (toggle) {
    toggle.textContent = isOpen ? "⌄" : "›";
    toggle.setAttribute("aria-label", isOpen ? "Collapse section" : "Expand section");
    toggle.setAttribute("title", isOpen ? "Collapse" : "Expand");
  }
}

function renderResident() {
  const user = state.profile;
  const paymentStatus = getResidentPaymentStatus(user);

  document.querySelector("#residentWelcome").textContent = `Hi, ${user.name}`;
  document.querySelector("#residentStatus").textContent = "Room assigned";
  document.querySelector("#residentStatus").className = "status-pill paid";
  document.querySelector("#myRoom").textContent = `${user.room} / ${user.bed}`;
  document.querySelector("#myRent").textContent = `Rs ${formatNumber(user.rent)}`;
  document.querySelector("#myDueDate").textContent = `Pay by ${formatOrdinalDay(user.dueDay)} every month`;
  document.querySelector("#myDeposit").textContent = `Rs ${formatNumber(user.deposit)}`;
  document.querySelector("#myPaymentStatus").textContent = paymentStatus.label;
  document.querySelector("#paymentForm").amount.value = user.rent || "";
  renderResidentPaymentMethods();

  renderProfile(user);
  renderMyPayments(user);
}

function renderResidentPaymentMethods() {
  const select = document.querySelector("#paymentMethodSelect");
  const submitButton = document.querySelector("#paymentForm button[type='submit']");
  const methods = getEnabledPaymentMethods();
  select.replaceChildren();

  methods.forEach((method) => {
    const option = document.createElement("option");
    option.value = method.value;
    option.textContent = method.label;
    select.append(option);
  });

  const hasMethods = methods.length > 0;
  select.disabled = !hasMethods;
  submitButton.disabled = !hasMethods;
  renderPaymentInstructions();
}

function renderPaymentInstructions() {
  const panel = document.querySelector("#paymentInstructions");
  const method = document.querySelector("#paymentMethodSelect").value;
  const settings = state.pg?.paymentSettings || {};
  let title = "Payment method not configured";
  let detail = "Ask your PG owner to enable UPI, bank transfer, or cash deposit.";

  if (method === "UPI") {
    title = "Pay using UPI";
    detail = settings.upiId ? `UPI ID: ${settings.upiId}` : "UPI ID is not configured.";
  }
  if (method === "Bank transfer") {
    title = "Pay using bank transfer";
    detail = settings.bankDetails || "Bank details are not configured.";
  }
  if (method === "Cash deposit") {
    title = "Pay using cash";
    detail = settings.cashInstructions || "Pay directly to the PG owner or manager.";
  }

  panel.innerHTML = `<strong>${escapeHtml(title)}</strong><p>${escapeHtml(detail)}</p>`;
}

function renderProfile(user) {
  document.querySelector("#residentProfile").innerHTML = `
    <div><span>Name</span><strong>${escapeHtml(user.name)}</strong></div>
    <div><span>Gmail</span><strong>${escapeHtml(user.email)}</strong></div>
    <div><span>Phone</span><strong>${escapeHtml(user.phone || "-")}</strong></div>
    <div><span>Aadhaar</span><strong>${maskAadhaar(user.aadhaar)}</strong></div>
    <div><span>Joining</span><strong>${formatDate(user.joiningDate)}</strong></div>
    <div><span>Address</span><strong>${escapeHtml(user.address || "-")}</strong></div>
  `;
}

function renderMyPayments(user) {
  const list = document.querySelector("#myPaymentHistory");
  list.replaceChildren();
  const payments = state.payments.filter((payment) => payment.residentId === user.id);

  if (!payments.length) {
    list.append(emptyNotice("No payments submitted", "Submit rent payment and wait for admin approval."));
    return;
  }

  payments
    .slice()
    .reverse()
    .forEach((payment) => {
      const card = document.createElement("article");
      card.className = "detail-card";
      card.innerHTML = `
        <div class="detail-card-head">
          <div>
            <strong>${getMonthLabel(payment.month)}</strong>
            <p>${escapeHtml(payment.method)} - ${escapeHtml(payment.transactionId)} - ${formatDate(payment.paidOn)}</p>
          </div>
          <span class="status-pill ${payment.status === "approved" ? "paid" : payment.status === "rejected" ? "due" : "waiting"}">${
        payment.status
      }</span>
        </div>
        <p class="muted-text">Amount: Rs ${formatNumber(payment.amount)}</p>
        ${payment.proofImage?.dataUrl ? `<button class="small-link-button" type="button" data-payment-proof="${payment.id}">View screenshot</button>` : ""}
      `;
      list.append(card);
    });
}

function openPaymentProof(paymentId) {
  const payment = state.payments.find((item) => item.id === paymentId);
  if (!payment?.proofImage?.dataUrl) {
    showToast("No screenshot is attached to this payment.", "error");
    return;
  }

  const resident = state.users.find((user) => user.id === payment.residentId);
  proofModalTitle.textContent = `${resident?.name || payment.residentEmail || "Payment"} screenshot`;
  proofModalImage.src = payment.proofImage.dataUrl;
  proofModalDownload.href = payment.proofImage.dataUrl;
  proofModalDownload.download = payment.proofImage.name || "payment-screenshot.jpg";
  proofModal.classList.remove("hidden");
  document.body.classList.add("modal-open");
}

function closePaymentProof() {
  proofModal.classList.add("hidden");
  proofModalImage.removeAttribute("src");
  proofModalDownload.href = "#";
  document.body.classList.remove("modal-open");
}

function getResidentPaymentStatus(resident) {
  if (!resident) return { label: "Pending", className: "due" };
  const payments = state.payments.filter((payment) => payment.residentId === resident.id && payment.month === monthKey);
  if (payments.some((payment) => payment.status === "approved")) return { label: "Paid", className: "paid" };
  if (payments.some((payment) => payment.status === "pending")) return { label: "Waiting approval", className: "waiting" };
  return isPaymentDue(resident) ? { label: "Due", className: "due" } : { label: "Upcoming", className: "waiting" };
}

function isPaymentDue(resident) {
  return new Date().getDate() >= Number(resident.dueDay || 1) && getResidentPaymentStatusNoDueLoop(resident) !== "covered";
}

function getResidentPaymentStatusNoDueLoop(resident) {
  const payments = state.payments.filter((payment) => payment.residentId === resident.id && payment.month === monthKey);
  return payments.some((payment) => payment.status === "approved" || payment.status === "pending") ? "covered" : "open";
}

function isBedTaken(room, bed) {
  return getActiveResidents().some((resident) => resident.room === room && resident.bed === bed);
}

function findResidentByBed(room, bed) {
  return getActiveResidents().find((resident) => resident.room === room && resident.bed === bed);
}

function roomHasResident(room, residentId) {
  return getActiveResidents().some((resident) => resident.id === residentId && resident.room === room.number);
}

function getOccupiedBeds(room) {
  return room.beds.filter((bed) => findResidentByBed(room.number, bed));
}

function getFloors() {
  const floorMap = new Map();
  state.rooms.forEach((room) => {
    const floorName = getFloorName(room.number);
    if (!floorMap.has(floorName)) floorMap.set(floorName, []);
    floorMap.get(floorName).push(room);
  });

  return [...floorMap.entries()]
    .sort(([floorA], [floorB]) => floorA.localeCompare(floorB, undefined, { numeric: true }))
    .map(([name, rooms]) => ({
      name,
      rooms: rooms.slice().sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true })),
    }));
}

function syncSelectedProperty() {
  const floors = getFloors();
  const floor = floors.find((item) => item.name === selectedProperty.floor) || floors[0];
  const room = floor?.rooms.find((item) => item.number === selectedProperty.room) || floor?.rooms[0];
  const bed = room?.beds.includes(selectedProperty.bed) ? selectedProperty.bed : room?.beds[0];
  selectedProperty = {
    floor: floor?.name || null,
    room: room?.number || null,
    bed: bed || null,
  };
}

function getFloorName(roomNumber) {
  const room = state.rooms.find((item) => item.number === roomNumber);
  if (room?.floor) return room.floor;
  const match = String(roomNumber || "").match(/(\d)/);
  return match ? `Floor ${match[1]}` : "Floor 1";
}

function getActiveResidents() {
  return state.users.filter((user) => user.role === "resident" && user.status === "active");
}

function getEnabledPaymentMethods() {
  const settings = state.pg?.paymentSettings || {};
  const methods = [];
  if (settings.allowUpi && settings.upiId) methods.push({ value: "UPI", label: "UPI" });
  if (settings.allowBank && settings.bankDetails) methods.push({ value: "Bank transfer", label: "Bank transfer" });
  if (settings.allowCash) methods.push({ value: "Cash deposit", label: "Cash deposit" });
  return methods;
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Content-Type", "application/json");
  const token = currentUser ? await currentUser.getIdToken() : null;
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const response = await fetch(path, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Request failed.");
  return payload;
}

function formToJson(form) {
  const data = new FormData(form);
  return Object.fromEntries([...data.entries()].map(([key, value]) => [key, typeof value === "string" ? value.trim() : value]));
}

async function buildPaymentProof(file) {
  if (!file || !file.size) return null;
  if (!file.type.startsWith("image/")) throw new Error("Payment screenshot must be an image file.");

  const image = await loadImage(file);
  const maxSide = 1200;
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.72);

  if (dataUrl.length > 900000) {
    throw new Error("Screenshot is too large. Please crop it or choose a smaller image.");
  }

  return {
    name: file.name,
    type: "image/jpeg",
    dataUrl,
  };
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(image.src);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(image.src);
      reject(new Error("Could not read payment screenshot."));
    };
    image.src = URL.createObjectURL(file);
  });
}

async function withButtonLock(button, label, task) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    await task();
  } catch (error) {
    showToast(getFriendlyError(error), "error");
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function showSetupError(message) {
  authScreen.classList.remove("hidden");
  appShell.classList.add("hidden");
  document.querySelector(".auth-card").innerHTML = `
    <div class="empty-state">
      <strong>Firebase setup needed</strong>
      <p>${escapeHtml(message)} Add Firebase environment variables and restart the server.</p>
    </div>
  `;
}

function showToast(message, type = "success") {
  toast.textContent = message;
  toast.className = `toast show ${type}`;
  window.setTimeout(() => toast.classList.remove("show"), 3200);
}

function getFriendlyError(error) {
  const message = error?.message || String(error);
  const authError = error?.code || "";
  if (authError.includes("auth/invalid-credential")) return "Email or password is incorrect.";
  if (authError.includes("auth/user-not-found")) return "No account exists for this Gmail.";
  if (authError.includes("auth/email-already-exists") || message.includes("already exists")) return "This Gmail is already added.";
  if (authError.includes("auth/weak-password")) return "Password must be at least 6 characters.";
  return message;
}

function getMonthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function getMonthLabel(value) {
  const [year, month] = String(value).split("-");
  return new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric" }).format(new Date(Number(year), Number(month) - 1));
}

function formatDate(value) {
  if (!value) return "not set";
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(new Date(value));
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-IN").format(Number(value || 0));
}

function formatOrdinalDay(value) {
  const day = Number(value || 1);
  const suffix =
    day % 10 === 1 && day !== 11 ? "st" : day % 10 === 2 && day !== 12 ? "nd" : day % 10 === 3 && day !== 13 ? "rd" : "th";
  return `${day}${suffix}`;
}

function maskAadhaar(value) {
  const digits = onlyDigits(value);
  if (digits.length < 4) return "****";
  return `**** **** ${digits.slice(-4)}`;
}

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function emptyNotice(title, body) {
  const item = document.createElement("article");
  item.className = "empty-state";
  item.innerHTML = `<strong>${escapeHtml(title)}</strong><p>${escapeHtml(body)}</p>`;
  return item;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function optionHtml(value, label, selectedValue) {
  return `<option value="${escapeAttr(value)}" ${value === selectedValue ? "selected" : ""}>${escapeHtml(label)}</option>`;
}
