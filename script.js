// ─────────────────────────────────────────────────────────────────────────────
//  Food Services Locator – script.js
//  Two separate search bars:
//    • #search-keyword  → live keyword filter (name / address / about)
//    • #search-location → live geocode suggestions dropdown + org name suggestions
//
//  IMPORTANT: The suggestions dropdown (#location-suggestions) is appended to
//  <body> and positioned with fixed coords so the sidebar's overflow:hidden
//  never clips it.
// ─────────────────────────────────────────────────────────────────────────────

// ── GitHub Pages URL (used by the fullscreen button) ──────────
// Update this to your actual GitHub Pages URL:
const GITHUB_PAGES_URL = "https://valley-verde.github.io/santaclarafood/";

function openFullscreen() {
  window.open(GITHUB_PAGES_URL, "_blank", "noopener,noreferrer");
}

// ── Mobile bottom-sheet toggle ─────────────────────────────────
(function () {
  const sidebar = document.querySelector(".sidebar");
  const handle  = document.getElementById("dragHandleWrap");
  if (!sidebar || !handle) return;

  let startY = 0, startExpanded = false;

  function isMobile() { return window.innerWidth <= 640; }

  handle.addEventListener("click", () => {
    if (!isMobile()) return;
    sidebar.classList.toggle("mobile-expanded");
  });

  // Also expand when user taps the tab bar
  document.querySelector(".tab-bar-wrap").addEventListener("click", () => {
    if (!isMobile()) return;
    sidebar.classList.add("mobile-expanded");
  });

  // Collapse the sheet when a map result is opened
  window.__collapseSheet = function () {
    if (isMobile()) sidebar.classList.remove("mobile-expanded");
  };

  // Basic touch-drag support
  handle.addEventListener("touchstart", (e) => {
    startY = e.touches[0].clientY;
    startExpanded = sidebar.classList.contains("mobile-expanded");
  }, { passive: true });

  handle.addEventListener("touchend", (e) => {
    if (!isMobile()) return;
    const dy = e.changedTouches[0].clientY - startY;
    if (dy < -30)       sidebar.classList.add("mobile-expanded");
    else if (dy > 30)   sidebar.classList.remove("mobile-expanded");
  }, { passive: true });
})();


const SHEET_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vR5x10jBXIWGB479G39llMNUZEGZwUqg92A4XjhdVaPdPmnhBijcCGUqtt7jVy4UCCBfoCtnYEl2VEv/pub?gid=46344147&single=true&output=csv";

// ── Map setup ──────────────────────────────────────────────────
const map = L.map("map", { maxZoom: 18 }).setView([37.328928, -121.911259], 11);
const markerCluster = L.markerClusterGroup({
  iconCreateFunction(cluster) {
    const count = cluster.getChildCount();
    const size = count < 10 ? "small" : count < 50 ? "medium" : "large";
    const dim = size === "small" ? 36 : size === "medium" ? 44 : 54;
    return L.divIcon({
      html: `<div class="custom-cluster ${size}">${count}</div>`,
      className: "",
      iconSize: L.point(dim, dim),
    });
  },
  maxClusterRadius: 50,
  spiderfyOnMaxZoom: true,
  showCoverageOnHover: false,
});
map.addLayer(markerCluster);


const basemapStyles = {
  street: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
    attribution:
      "Tiles © Esri — Source: Esri, DeLorme, NAVTEQ, USGS, Intermap, iPC, NRCAN, Esri Japan, METI, Esri China (Hong Kong), Esri (Thailand), TomTom, 2012",
  },
  satellite: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "Tiles © Esri — Source: Esri, DigitalGlobe, GeoEye, i-cubed, Earthstar Geographics",
  },
  topo: {
    url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    attribution:
      "Map data © OpenStreetMap contributors, SRTM | Map style © OpenTopoMap (CC-BY-SA)",
    subdomains: ["a", "b", "c"],
  },
  light: {
    url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
    attribution: "&copy; OpenStreetMap contributors & CARTO",
    subdomains: ["a", "b", "c", "d"],
  },
};
let currentTileLayer = null;

function setBasemap(style = "street") {
  const config = basemapStyles[style] || basemapStyles.street;
  if (currentTileLayer) map.removeLayer(currentTileLayer);
  currentTileLayer = L.tileLayer(config.url, {
    attribution: config.attribution,
    subdomains: config.subdomains || "abc",
  }).addTo(map);
}

function changeBasemap(style) {
  setBasemap(style);
}

setBasemap("street");







// Direct Nominatim geocoding — no library wrapper needed
async function nominatimGeocode(query) {
  const params = new URLSearchParams({
    q: query,
    format: "json",
    addressdetails: "1",
    limit: "5",
    countrycodes: "us",
  });
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
      headers: { "Accept-Language": "en" },
    });
    const data = await res.json();
    return data.map((r) => ({
      name: r.display_name,
      center: L.latLng(parseFloat(r.lat), parseFloat(r.lon)),
    }));
  } catch (e) {
    console.error("Geocode error:", e);
    return [];
  }
}

// ── State ──────────────────────────────────────────────────────
let locations = [];
let otherResources = [];
let allFields = [];   // all CSV column headers, used for service detail lookup
let markers = [];
let centerPoint = null;
let radiusCircle = null;
let userMarker = null;
let activeSuggestionIndex = -1;
let keywordDebounce = null;
let locationDebounce = null;

// ── Create body-level dropdown elements ───────────────────────
// Location bar dropdown
const dropdown = document.createElement("div");
dropdown.id = "location-suggestions";
dropdown.className = "sugg-dropdown";
dropdown.style.display = "none";
document.body.appendChild(dropdown);

// Keyword bar dropdown
const kwDropdown = document.createElement("div");
kwDropdown.id = "keyword-suggestions";
kwDropdown.className = "sugg-dropdown";
kwDropdown.style.display = "none";
document.body.appendChild(kwDropdown);

const els = {
  searchKeyword: document.getElementById("search-keyword"),
  searchLocation: document.getElementById("search-location"),
  radius: document.getElementById("radius"),
  radiusValue: document.getElementById("radiusValue"),
  resultCount: document.getElementById("resultCount"),
  locationList: document.getElementById("locationList"),
  panelFilters: document.getElementById("panel-filters"),
  panelResults: document.getElementById("panel-results"),
  tabFilters: document.getElementById("tab-filters"),
  tabResults: document.getElementById("tab-results"),
};

// ── Haversine ──────────────────────────────────────────────────
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Load data ──────────────────────────────────────────────────
Papa.parse(SHEET_URL, {
  download: true,
  header: true,
  skipEmptyLines: true,
  complete(results) {
    allFields = results.meta.fields || [];

    const parsedRows = results.data.map((r) => ({
      name: (r.Organization_Name || "").trim(),
      address: (r.Address || "").trim(),
      lat: parseFloat(r.Latitude),
      lng: parseFloat(r.Longitude),
      about: (r.About || "").trim(),
      website: (r.Website || "").trim(),
      phone: (r.Phone_Number || "").trim(),
      services_offered: (r.Services_Offered || "").toLowerCase().trim(),
      services_offered_raw: (r.Services_Offered || "").trim(),
      org_type: (r.Organization_Type || "").trim(),
      parent_org: (r.Parent_Organization || "").trim(),
      locations_served: (r.Locations_Served || "").toLowerCase().trim(),
      locations_served_raw: (r.Locations_Served || "").trim(),
      rawRow: r,
    }));

    locations = parsedRows.filter((l) => !isNaN(l.lat) && !isNaN(l.lng));
    otherResources = parsedRows.filter((l) => isNaN(l.lat) || isNaN(l.lng));

    locations.forEach((l) => {
      l.serviceDays = getServiceDays(l);
    });
    buildServiceFilters();
    buildAreasFilter();
    buildParentOrgFilter();
    buildOrgTypeFilter();
    buildOtherResourcesPanel();
    applyFilters();
  },
  error(err) {
    console.error("Error loading data:", err);
    document.getElementById("locationList").innerHTML =
      '<div class="state-msg"><span class="emoji">⚠️</span>Could not load data.<br>Please refresh the page.</div>';
  },
});

// ── Shared: case-insensitive dedup helper ─────────────────────
// Given an array of raw strings (possibly comma/semicolon-separated),
// returns sorted unique values preserving the first-seen casing.
function normalizeFieldKey(str) {
  return String(str)
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, " ")
    .replace(/[^a-z0-9 ]/g, "");
}

function extractDaysFromText(text) {
  const days = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
  ];
  const normalized = String(text).toLowerCase();
  return days.filter((day) => normalized.includes(day));
}

function findServiceField(service, fieldMap) {
  const normalizedService = normalizeFieldKey(service);
  if (fieldMap.has(normalizedService)) return fieldMap.get(normalizedService);

  const serviceTerms = normalizedService.split(" ").filter(Boolean);
  for (const [fieldKey, fieldName] of fieldMap.entries()) {
    if (serviceTerms.every((term) => fieldKey.includes(term))) return fieldName;
  }

  for (const [fieldKey, fieldName] of fieldMap.entries()) {
    if (normalizedService.includes(fieldKey) || fieldKey.includes(normalizedService)) return fieldName;
  }

  return undefined;
}

function getServiceDays(loc) {
  if (!loc.services_offered_raw || !loc.rawRow) return [];
  const services = loc.services_offered_raw
    .split(/[,;]/)
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter(Boolean);

  const fieldMap = new Map();
  allFields.forEach((f) => fieldMap.set(normalizeFieldKey(f), f));

  const daySet = new Set();
  services.forEach((service) => {
    const matchingField = findServiceField(service, fieldMap);
    if (!matchingField) return;
    const detailText = String(loc.rawRow[matchingField] || "");
    extractDaysFromText(detailText).forEach((day) => daySet.add(day));
  });

  return [...daySet];
}

function uniqueValues(rawList) {
  const seen = new Map(); // normalized lowercase key → preferred casing
  rawList.forEach((raw) => {
    if (!raw) return;
    raw.split(/[,;]/)
      .map((s) => s.trim().replace(/\s+/g, " ")) // collapse internal spaces
      .filter(Boolean)
      .forEach((s) => {
        const key = s.toLowerCase();
        if (!seen.has(key)) seen.set(key, s);
      });
  });
  return [...seen.values()].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" })
  );
}

// ── Shared: build a checkbox group dynamically ─────────────────
function buildCheckboxGroup(containerId, values, cssClass) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";
  if (values.length === 0) {
    container.innerHTML = '<p style="font-size:0.78rem;color:var(--text-muted);padding:4px 0">No data found.</p>';
    return;
  }
  values.forEach((val) => {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = cssClass;
    cb.value = val;
    cb.addEventListener("change", applyFilters);
    label.appendChild(cb);
    label.appendChild(document.createTextNode(" " + val));
    container.appendChild(label);
  });
}

// ── Dynamic filter builders ────────────────────────────────────
function buildServiceFilters() {
  const values = uniqueValues(locations.map((l) => l.services_offered_raw));
  buildCheckboxGroup("serviceFilters", values, "service-filter");
}

function buildAreasFilter() {
  const values = uniqueValues(locations.map((l) => l.locations_served_raw));
  buildCheckboxGroup("areasFilters", values, "locationFilter");
}

function buildParentOrgFilter() {
  // Each parent_org is a single value (not comma-separated), 
  // but may have trailing spaces — normalize via uniqueValues
  const values = uniqueValues(
    locations
      .map((l) => l.parent_org)
      .filter(Boolean)
      .map((v) => v.trim())
  );
  buildCheckboxGroup("parentOrgFilters", values, "parentOrgFilter");
}

function buildOrgTypeFilter() {
  const values = uniqueValues(
    locations
      .map((l) => l.org_type)
      .filter(Boolean)
      .map((v) => v.trim())
  );
  buildCheckboxGroup("orgTypeFilters", values, "orgTypeFilter");
}

function buildOtherResourcesPanel() {
  const list = document.getElementById("otherResourcesList");
  const badge = document.getElementById("otherResourcesBadge");
  if (!list || !badge) return;
  badge.textContent = otherResources.length;

  if (!otherResources.length) {
    list.innerHTML = '<div class="other-resource-empty">No other resources available.</div>';
    return;
  }

  renderFilteredOtherResources(otherResources);
}

function renderFilteredOtherResources(filtered) {
  const list = document.getElementById("otherResourcesList");
  if (!list) return;

  if (!filtered.length) {
    list.innerHTML = '<div class="other-resource-empty">No resources match your search.</div>';
    return;
  }

  list.innerHTML = filtered
    .map((resource) => {
      const title = resource.name || resource.about || "Other resource";
      const subtitle =
        resource.parent_org ||
        resource.org_type ||
        resource.locations_served ||
        resource.address ||
        "";
      const actualIndex = otherResources.indexOf(resource);
      return `
        <button type="button" class="other-resource-item" data-index="${actualIndex}">
          <span class="other-resource-title">${escHtml(title)}</span>
          ${subtitle ? `<span class="other-resource-meta">${escHtml(subtitle)}</span>` : ""}
        </button>
      `;
    })
    .join("");
}

function filterOtherResources(searchTerm) {
  const normalized = searchTerm.toLowerCase().trim();
  if (!normalized) {
    renderFilteredOtherResources(otherResources);
    return;
  }

  const filtered = otherResources.filter((resource) => {
    const name = (resource.name || "").toLowerCase();
    const about = (resource.about || "").toLowerCase();
    const address = (resource.address || "").toLowerCase();
    const org = (resource.parent_org || "").toLowerCase();
    return (
      name.includes(normalized) ||
      about.includes(normalized) ||
      address.includes(normalized) ||
      org.includes(normalized)
    );
  });

  renderFilteredOtherResources(filtered);
}

function showOtherResourceDetails(index) {
  const details = document.getElementById("otherResourcesDetails");
  if (!details) return;
  const resource = otherResources[Number(index)];
  if (!resource) {
    details.innerHTML = "";
    return;
  }

  const websiteMarkup = resource.website
    ? `<a href="${escHtml(resource.website)}" target="_blank" rel="noopener noreferrer">Visit website</a>`
    : "";
  const phoneMarkup = resource.phone
    ? `<a href="tel:${encodeURIComponent(resource.phone)}">Call ${escHtml(resource.phone)}</a>`
    : "";

  details.innerHTML = `
    <div class="other-resources-card">
      <strong>${escHtml(resource.name || "Other resource")}</strong>
      ${resource.about ? `<p>${escHtml(resource.about)}</p>` : ""}
      ${resource.address ? `<p>${escHtml(resource.address)}</p>` : ""}
      ${resource.parent_org ? `<p><strong>Organization:</strong> ${escHtml(resource.parent_org)}</p>` : ""}
      <div class="popup-actions">${websiteMarkup}${phoneMarkup}</div>
    </div>
  `;
}

function setOtherResourcesPanelOpen(isOpen) {
  const panel = document.getElementById("otherResourcesPanel");
  const toggle = document.getElementById("otherResourcesToggle");
  if (!panel || !toggle) return;
  panel.hidden = !isOpen;
  toggle.setAttribute("aria-expanded", String(isOpen));
  if (!isOpen) {
    const details = document.getElementById("otherResourcesDetails");
    if (details) details.innerHTML = "";
  }
}

// ── Suggestions helpers ────────────────────────────────────────

function positionDropdown() {
  const input = els.searchLocation;
  const rect = input.getBoundingClientRect();
  dropdown.style.position = "fixed";
  dropdown.style.top = rect.bottom + 4 + "px";
  dropdown.style.left = rect.left + "px";
  dropdown.style.width = rect.width + "px";
}

function hideSuggestions() {
  dropdown.style.display = "none";
  dropdown.innerHTML = "";
  activeSuggestionIndex = -1;
}

function hideKeywordSuggestions() {
  kwDropdown.style.display = "none";
  kwDropdown.innerHTML = "";
}

function positionKeywordDropdown() {
  const input = els.searchKeyword;
  const rect = input.getBoundingClientRect();
  kwDropdown.style.position = "fixed";
  kwDropdown.style.top = rect.bottom + 4 + "px";
  kwDropdown.style.left = rect.left + "px";
  kwDropdown.style.width = rect.width + "px";
}

function renderKeywordSuggestions(orgs) {
  kwDropdown.innerHTML = "";

  if (!orgs.length) {
    kwDropdown.style.display = "none";
    return;
  }

  positionKeywordDropdown();

  orgs.forEach((loc) => {
    const item = document.createElement("div");
    item.className = "sugg-item sugg-org";
    item.innerHTML =
      `<span class="sugg-icon">🏢</span>` +
      `<span class="sugg-text">${escHtml(loc.name)}` +
      `<span class="sugg-addr">${escHtml(loc.address)}</span></span>`;
    item.addEventListener("mousedown", (e) => {
      e.preventDefault();
      els.searchKeyword.value = loc.name;
      hideKeywordSuggestions();
      applyFilters();
      // Fly to and open this org's marker
      map.flyTo([loc.lat, loc.lng], 15, { duration: 0.8 });
      setTimeout(() => {
        const idx = locations.findIndex(
          (l) => l.lat === loc.lat && l.lng === loc.lng && l.name === loc.name
        );
        if (idx !== -1 && markers[idx]) markers[idx].openPopup();
        const items = document.querySelectorAll(".location-item");
        items.forEach((i) => i.classList.remove("active"));
        if (items[idx]) {
          items[idx].classList.add("active");
          items[idx].scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
        switchTab("results");
      }, 500);
    });
    kwDropdown.appendChild(item);
  });

  kwDropdown.style.display = "block";
}

function renderSuggestions(locResults, orgResults) {
  dropdown.innerHTML = "";
  activeSuggestionIndex = -1;

  if (!locResults.length && !orgResults.length) {
    dropdown.style.display = "none";
    return;
  }

  positionDropdown();

  // ── Geocoded location results ──
  if (locResults.length) {
    const label = document.createElement("div");
    label.className = "sugg-group-label";
    label.textContent = "Locations";
    dropdown.appendChild(label);

    locResults.forEach((r) => {
      const item = document.createElement("div");
      item.className = "sugg-item sugg-location";
      item.innerHTML =
        `<span class="sugg-icon">📍</span>` +
        `<span class="sugg-text">${escHtml(r.name)}</span>`;
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        pickLocation(r);
      });
      dropdown.appendChild(item);
    });
  }

  // ── Org results ──
  if (orgResults.length) {
    if (locResults.length) {
      const sep = document.createElement("div");
      sep.className = "sugg-sep";
      dropdown.appendChild(sep);
    }

    const label = document.createElement("div");
    label.className = "sugg-group-label";
    label.textContent = "Organizations";
    dropdown.appendChild(label);

    orgResults.forEach((loc) => {
      const item = document.createElement("div");
      item.className = "sugg-item sugg-org";
      item.innerHTML =
        `<span class="sugg-icon">🏢</span>` +
        `<span class="sugg-text">${escHtml(loc.name)}` +
        `<span class="sugg-addr">${escHtml(loc.address)}</span></span>`;
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        pickOrg(loc);
      });
      dropdown.appendChild(item);
    });
  }

  dropdown.style.display = "block";
}

function pickLocation(result) {
  centerPoint = L.latLng(result.center.lat, result.center.lng);
  els.searchLocation.value = result.name;
  hideSuggestions();
  map.setView(centerPoint, 13);
  if (userMarker) map.removeLayer(userMarker);
  userMarker = L.marker(centerPoint, {
    icon: L.divIcon({
      className: "",
      html: `<div class="you-are-here-pin search-pin"><div class="yah-pulse"></div><div class="yah-dot"></div></div>`,
      iconSize: [36, 36],
      iconAnchor: [18, 18],
    }),
  })
    .addTo(map)
    .bindPopup(`
      <div class="popup-card yah-popup">
        <div class="popup-header yah-header">
          <div class="yah-icon-wrap">🔍</div>
          <div class="popup-title">${escHtml(result.name)}</div>
        </div>
        <div class="popup-body yah-body">
          <div class="yah-note">Showing results near this location</div>
        </div>
      </div>
    `, { maxWidth: 220 })
    .openPopup();
  applyFilters();
}

function pickOrg(loc) {
  els.searchLocation.value = loc.name;
  hideSuggestions();
  map.flyTo([loc.lat, loc.lng], 15, { duration: 0.8 });
  setTimeout(() => {
    const idx = locations.findIndex(
      (l) => l.lat === loc.lat && l.lng === loc.lng && l.name === loc.name,
    );
    if (idx !== -1 && markers[idx]) markers[idx].openPopup();
    const items = document.querySelectorAll(".location-item");
    items.forEach((i) => i.classList.remove("active"));
    if (items[idx]) {
      items[idx].classList.add("active");
      items[idx].scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    switchTab("results");
  }, 500);
}

// Keyboard navigation inside the location dropdown
function handleLocationKeydown(e) {
  const items = dropdown.querySelectorAll(".sugg-item");
  if (!items.length && e.key !== "Enter") return;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    activeSuggestionIndex = Math.min(activeSuggestionIndex + 1, items.length - 1);
    items.forEach((i, idx) => i.classList.toggle("sugg-active", idx === activeSuggestionIndex));
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    activeSuggestionIndex = Math.max(activeSuggestionIndex - 1, -1);
    items.forEach((i, idx) => i.classList.toggle("sugg-active", idx === activeSuggestionIndex));
  } else if (e.key === "Enter") {
    if (activeSuggestionIndex >= 0 && items[activeSuggestionIndex]) {
      e.preventDefault();
      items[activeSuggestionIndex].dispatchEvent(new Event("mousedown"));
    } else {
      // Plain Enter — geocode the raw typed value
      hideSuggestions();
      const q = els.searchLocation.value.trim();
      if (q) {
        nominatimGeocode(q).then((results) => {
          if (results.length > 0) {
            pickLocation(results[0]);
          } else {
            alert("Location not found. Please try a different address or ZIP code.");
          }
        });
      }
    }
  } else if (e.key === "Escape") {
    hideSuggestions();
  }
}

// ── Accordion ─────────────────────────────────────────────────
function toggleAccordion(btn) {
  const body = btn.nextElementSibling;
  const isOpen = btn.classList.contains("open");
  btn.classList.toggle("open", !isOpen);
  body.classList.toggle("open", !isOpen);
}

function updateAccordionBadges() {
  // Services
  const servCount = document.querySelectorAll(".service-filter:checked").length;
  const servBadge = document.getElementById("acc-badge-services");
  servBadge.textContent = servCount || "";
  servBadge.classList.toggle("visible", servCount > 0);

  // Days
  const dayCount = document.querySelectorAll(".dayFilter:checked").length;
  const dayBadge = document.getElementById("acc-badge-days");
  dayBadge.textContent = dayCount || "";
  dayBadge.classList.toggle("visible", dayCount > 0);

  // Areas
  const areaCount = document.querySelectorAll(".locationFilter:checked").length;
  const areaBadge = document.getElementById("acc-badge-areas");
  areaBadge.textContent = areaCount || "";
  areaBadge.classList.toggle("visible", areaCount > 0);

  // Parent Org
  const parentCount = document.querySelectorAll(".parentOrgFilter:checked").length;
  const parentBadge = document.getElementById("acc-badge-parent");
  if (parentBadge) {
    parentBadge.textContent = parentCount || "";
    parentBadge.classList.toggle("visible", parentCount > 0);
  }

  // Organization Type
  const orgTypeCount = document.querySelectorAll(".orgTypeFilter:checked").length;
  const orgTypeBadge = document.getElementById("acc-badge-orgtype");
  if (orgTypeBadge) {
    orgTypeBadge.textContent = orgTypeCount || "";
    orgTypeBadge.classList.toggle("visible", orgTypeCount > 0);
  }

  // Radius
  const radius = parseFloat(document.getElementById("radius").value);
  const radBadge = document.getElementById("acc-badge-radius");
  radBadge.textContent = radius > 0 ? `${radius} mi` : "";
  radBadge.classList.toggle("visible", radius > 0);
}

// ── Filters ────────────────────────────────────────────────────
function applyFilters() {
  const term = els.searchKeyword.value.toLowerCase().trim();
  const radius = parseFloat(document.getElementById("radius").value);
  const checkedServs = [...document.querySelectorAll(".service-filter:checked")].map((cb) => cb.value);
  const checkedDays = [...document.querySelectorAll(".dayFilter:checked")].map((cb) => cb.value);
  const checkedLocs = [...document.querySelectorAll(".locationFilter:checked")].map((cb) => cb.value);
  const checkedParents = [...document.querySelectorAll(".parentOrgFilter:checked")].map((cb) => cb.value);
  const checkedOrgTypes = [...document.querySelectorAll(".orgTypeFilter:checked")].map((cb) => cb.value);

  let filtered = locations.filter((l) => {
    if (
      term &&
      !l.name.toLowerCase().includes(term) &&
      !l.address.toLowerCase().includes(term) &&
      !l.about.toLowerCase().includes(term)
    )
      return false;

    if (checkedServs.length && !checkedServs.some((s) => l.services_offered.includes(s.toLowerCase())))
      return false;

    if (checkedDays.length) {
      const serviceDays = l.serviceDays || [];
      const dayMatch = checkedDays.some((d) =>
        serviceDays.some((serviceDay) => serviceDay.toLowerCase() === d.toLowerCase()) ||
        (l.days && l.days.toLowerCase().includes(d.toLowerCase()))
      );
      if (!dayMatch) return false;
    }

    if (checkedLocs.length && !checkedLocs.some((loc) => l.locations_served.includes(loc.toLowerCase())))
      return false;

    if (checkedParents.length && !checkedParents.some((p) => l.parent_org.trim().toLowerCase() === p.trim().toLowerCase()))
      return false;

    if (checkedOrgTypes.length && !checkedOrgTypes.some((t) => l.org_type.trim().toLowerCase() === t.trim().toLowerCase()))
      return false;

    if (centerPoint && radius > 0) {
      const dist = haversineDistance(centerPoint.lat, centerPoint.lng, l.lat, l.lng);
      if (dist > radius) return false;
    }

    return true;
  });

  // Sort: by distance if center point active, otherwise alphabetically
  if (centerPoint) {
    filtered = filtered
      .map((l) => ({
        ...l,
        _dist: haversineDistance(centerPoint.lat, centerPoint.lng, l.lat, l.lng),
      }))
      .sort((a, b) => a._dist - b._dist);
  } else {
    filtered = filtered.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    );
  }

  renderLocations(filtered);
  updateAccordionBadges();
}

// ── Reset ──────────────────────────────────────────────────────
function resetFilters() {
  els.searchKeyword.value = "";
  els.searchLocation.value = "";
  els.radius.value = 0;
  els.radiusValue.textContent = 0;
  document.querySelectorAll(".service-filter, .dayFilter, .locationFilter, .parentOrgFilter, .orgTypeFilter").forEach((cb) => (cb.checked = false));
  centerPoint = null;
  hideSuggestions();
  hideKeywordSuggestions();
  if (radiusCircle) { map.removeLayer(radiusCircle); radiusCircle = null; }
  if (userMarker) { map.removeLayer(userMarker); userMarker = null; }
  applyFilters();
}

// ── Tabs ──────────────────────────────────────────────────────
function switchTab(tab) {
  els.panelFilters.style.display = tab === "filters" ? "flex" : "none";
  els.panelResults.style.display = tab === "results" ? "flex" : "none";
  els.tabFilters.classList.toggle("active", tab === "filters");
  els.tabResults.classList.toggle("active", tab === "results");
}

// ── Service detail renderer ────────────────────────────────────
// Splits Services_Offered into individual services, looks up each one
// as a column header in the spreadsheet, and builds subheader + body HTML.
function buildServiceDetails(loc) {
  if (!loc.services_offered_raw) return "";

  const services = loc.services_offered_raw
    .split(/[,;]/)
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter(Boolean);

  if (!services.length) return "";

  // Build a normalized lookup map: service label → original field name
  const fieldMap = new Map();
  allFields.forEach((f) => fieldMap.set(normalizeFieldKey(f), f));

  let html = `<div class="popup-section popup-services"><strong>🛠 Services</strong>`;

  services.forEach((service) => {
    const matchingField = findServiceField(service, fieldMap);
    const detail = matchingField ? (loc.rawRow[matchingField] || "").trim() : "";

    html += `<div class="service-block">`;
    html += `<div class="service-subheader">${escHtml(service)}</div>`;
    if (detail) {
      html += `<div class="service-detail">${escHtml(detail)}</div>`;
    }
    html += `</div>`;
  });

  html += `</div>`;
  return html;
}

// ── Render locations ──────────────────────────────────────────
function renderLocations(data) {
  markerCluster.clearLayers();
  markers = [];

  const list = els.locationList;
  list.innerHTML = "";

  els.resultCount.textContent = data.length === 0 ? "0" : `${data.length}`;

  if (data.length === 0) {
    list.innerHTML =
      '<div class="state-msg"><span class="emoji">🔍</span>No locations match your filters.<br>Try adjusting your search.</div>';
    return;
  }

  data.forEach((loc) => {
    const pinIcon = L.divIcon({
      className: "",
      html: `<div class="loc-pin"><div class="loc-pin-head"></div><div class="loc-pin-shadow"></div></div>`,
      iconSize: [28, 36],
      iconAnchor: [14, 36],
      popupAnchor: [0, -36],
    });
    const marker = L.marker([loc.lat, loc.lng], { icon: pinIcon });
    markerCluster.addLayer(marker);

    marker.bindPopup(`
      <div class="popup-card">
        <div class="popup-header">
          <div class="popup-title">${escHtml(loc.name)}</div>
        </div>
        <div class="popup-body">
          <div class="popup-section">
            <strong>📍 Address</strong>${escHtml(loc.address)}
          </div>
          ${loc.phone ? `<div class="popup-section"><strong>📞 Phone</strong>${escHtml(loc.phone)}</div>` : ""}
          ${loc.org_type ? `<div class="popup-section"><strong>🏷 Organization Type</strong>${escHtml(loc.org_type)}</div>` : ""}
          ${loc.parent_org ? `<div class="popup-section"><strong>🏛 Parent Organization</strong>${escHtml(loc.parent_org)}</div>` : ""}
          ${loc.about ? `<div class="popup-section"><strong>ℹ️ About</strong>${escHtml(loc.about)}</div>` : ""}
          ${buildServiceDetails(loc)}
          ${loc.locations_served ? `<div class="popup-section"><strong>📌 Areas Served</strong>${escHtml(loc.locations_served)}</div>` : ""}
            ${loc.website ? `<a class="popup-button" href="${loc.website}" target="_blank" rel="noopener noreferrer">Visit Website ↗</a>` : ""}
            <a class="popup-button popup-button--directions"
              href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(loc.address)}"
              target="_blank" rel="noopener noreferrer">🗺 Get Directions ↗</a>
          </div>
        </div>
      </div>
    `);
    markers.push(marker);

    const distBadge = loc._dist !== undefined
      ? `<span class="item-dist">${loc._dist < 0.1 ? "< 0.1" : loc._dist.toFixed(1)} mi</span>`
      : "";
    const div = document.createElement("div");
    div.className = "location-item";
    div.innerHTML = `<div class="item-header"><div class="item-name">${escHtml(loc.name)}</div>${distBadge}</div><div class="item-addr">${escHtml(loc.address)}</div>`;

    div.onclick = () => {
      document.querySelectorAll(".location-item").forEach((i) => i.classList.remove("active"));
      div.classList.add("active");
      // zoomToShowLayer ensures the marker is unclustered before opening the popup
      markerCluster.zoomToShowLayer(marker, () => {
        marker.openPopup();
      });
    };

    marker.on("click", () => {
      switchTab("results");
      if (window.__collapseSheet) window.__collapseSheet();
      document.querySelectorAll(".location-item").forEach((i) => i.classList.remove("active"));
      div.classList.add("active");
      div.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });

    list.appendChild(div);
  });

  // Always fit map to visible results
  if (markers.length > 0) {
    const bounds = markerCluster.getBounds();
    if (bounds.isValid()) {
      map.fitBounds(bounds.pad(0.12), { maxZoom: centerPoint ? 14 : 13 });
    }
  }
}

// ── XSS helper ─────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Locate user ─────────────────────────────────────────────────
async function locateByIP() {
  try {
    const response = await fetch("https://ipapi.co/json/");
    if (!response.ok) throw new Error("IP service request failed");
    const data = await response.json();
    const lat = parseFloat(data.latitude);
    const lng = parseFloat(data.longitude);
    if (!data || Number.isNaN(lat) || Number.isNaN(lng)) {
      throw new Error("IP location data invalid");
    }
    setUserLocation(lat, lng, "📍 Approximate location");
  } catch (error) {
    console.error("IP location lookup failed:", error);
    alert(
      "Could not determine your approximate location from your IP address. Please enter an address manually."
    );
  }
}

function setUserLocation(lat, lng, label) {
  centerPoint = L.latLng(lat, lng);
  els.searchLocation.value = label;
  hideSuggestions();
  if (userMarker) {
    map.removeLayer(userMarker);
  }
  userMarker = L.marker(centerPoint, {
    icon: L.divIcon({
      className: "",
      html: `<div class="you-are-here-pin"><div class="yah-pulse"></div><div class="yah-dot"></div></div>`,
      iconSize: [36, 36],
      iconAnchor: [18, 18],
    }),
  })
    .addTo(map)
    .bindPopup(`
      <div class="popup-card yah-popup">
        <div class="popup-header yah-header">
          <div class="yah-icon-wrap">📍</div>
          <div class="popup-title">You are here</div>
        </div>
        <div class="popup-body yah-body">
          <div class="yah-coords">${centerPoint.lat.toFixed(5)}, ${centerPoint.lng.toFixed(5)}</div>
          <div class="yah-note">Showing results near your approximate location</div>
        </div>
      </div>
    `, { maxWidth: 220 })
    .openPopup();
  map.setView(centerPoint, 13);
  applyFilters();
}

function locateUser() {
  locateByIP();
}

// ── Event listeners ────────────────────────────────────────────

// Keyword bar — live filter + org name suggestions
els.searchKeyword.addEventListener("input", function () {
  const val = this.value.trim();
  clearTimeout(keywordDebounce);

  if (!val) {
    hideKeywordSuggestions();
    applyFilters();
    return;
  }

  keywordDebounce = setTimeout(() => {
    applyFilters();
    const term = val.toLowerCase();
    const orgMatches = locations
      .filter((l) => l.name.toLowerCase().includes(term))
      .slice(0, 6);
    renderKeywordSuggestions(orgMatches);
  }, 250);
});

els.searchKeyword.addEventListener("keydown", function (e) {
  const items = kwDropdown.querySelectorAll(".sugg-item");
  if (!items.length) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    const next = Math.min((parseInt(kwDropdown.dataset.active ?? "-1")) + 1, items.length - 1);
    items.forEach((i, idx) => i.classList.toggle("sugg-active", idx === next));
    kwDropdown.dataset.active = next;
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    const prev = Math.max((parseInt(kwDropdown.dataset.active ?? "0")) - 1, -1);
    items.forEach((i, idx) => i.classList.toggle("sugg-active", idx === prev));
    kwDropdown.dataset.active = prev;
  } else if (e.key === "Enter") {
    const active = parseInt(kwDropdown.dataset.active ?? "-1");
    if (active >= 0 && items[active]) {
      e.preventDefault();
      items[active].dispatchEvent(new Event("mousedown"));
    } else {
      hideKeywordSuggestions();
    }
  } else if (e.key === "Escape") {
    hideKeywordSuggestions();
  }
});

// Dismiss keyword suggestions on outside click
document.addEventListener("click", (e) => {
  if (
    !e.target.closest("#search-keyword") &&
    !e.target.closest("#keyword-suggestions")
  ) {
    hideKeywordSuggestions();
  }
});

// Location bar — live geocode + org suggestions
els.searchLocation.addEventListener("input", function () {
  const val = this.value.trim();

  if (!val) {
    centerPoint = null;
    if (userMarker) { map.removeLayer(userMarker); userMarker = null; }
    hideSuggestions();
    applyFilters();
    return;
  }

  clearTimeout(locationDebounce);
  locationDebounce = setTimeout(() => {
    const term = val.toLowerCase();

    // Org matches from loaded dataset
    const orgMatches = locations
      .filter((l) => l.name.toLowerCase().includes(term))
      .slice(0, 4);

    // Geocode for place suggestions
    nominatimGeocode(val).then((results) => {
      renderSuggestions(results.slice(0, 3), orgMatches);
    });
  }, 300);
});

els.searchLocation.addEventListener("keydown", handleLocationKeydown);

// Keep dropdown aligned on resize
window.addEventListener("resize", () => {
  if (dropdown.style.display === "block") positionDropdown();
});

// Dismiss on outside click
document.addEventListener("click", (e) => {
  if (
    !e.target.closest("#search-location") &&
    !e.target.closest("#location-suggestions")
  ) {
    hideSuggestions();
  }
});

els.radius.addEventListener("input", function () {
  els.radiusValue.textContent = this.value;
  applyFilters();
});

const otherResourcesToggle = document.getElementById("otherResourcesToggle");
const otherResourcesClose = document.getElementById("otherResourcesClose");
const otherResourcesList = document.getElementById("otherResourcesList");

if (otherResourcesToggle) {
  otherResourcesToggle.addEventListener("click", () => {
    const panel = document.getElementById("otherResourcesPanel");
    if (!panel) return;
    setOtherResourcesPanelOpen(panel.hidden);
  });
}

if (otherResourcesClose) {
  otherResourcesClose.addEventListener("click", () => setOtherResourcesPanelOpen(false));
}

if (otherResourcesList) {
  otherResourcesList.addEventListener("click", (event) => {
    const item = event.target.closest(".other-resource-item");
    if (!item) return;
    showOtherResourceDetails(item.dataset.index);
  });
}

document.addEventListener("click", (event) => {
  const overlay = document.getElementById("otherResourcesOverlay");
  const panel = document.getElementById("otherResourcesPanel");
  if (!overlay || !panel || panel.hidden) return;
  if (!event.target.closest("#otherResourcesOverlay")) {
    setOtherResourcesPanelOpen(false);
  }
});

// Other resources search input
const otherResourcesSearch = document.getElementById("otherResourcesSearch");
if (otherResourcesSearch) {
  otherResourcesSearch.addEventListener("input", (e) => {
    filterOtherResources(e.target.value);
  });
}

// Static filters (day + area) — service filters get listeners in buildServiceFilters()
document
  .querySelectorAll(".dayFilter, .locationFilter")
  .forEach((cb) => cb.addEventListener("change", applyFilters));
