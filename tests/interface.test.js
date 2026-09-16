// Chargement reel de l'interface, avec un DOM et un Leaflet reduits au
// strict necessaire. Sans cela, une erreur de cablage (element absent,
// variable lue avant sa declaration, ecouteur pose sur le mauvais objet) ne
// se verrait qu'en ouvrant la page dans un navigateur.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(RACINE, "docs", "index.html"), "utf-8");

// --- DOM minimal ----------------------------------------------------------
function faitElement(id = "") {
  const ecouteurs = new Map();
  return {
    id, textContent: "", innerHTML: "", value: "", checked: false,
    hidden: false, disabled: false, style: {}, href: "", download: "",
    firstElementChild: { style: {} },
    classList: {
      valeurs: new Set(),
      toggle(nom, actif) { actif ? this.valeurs.add(nom) : this.valeurs.delete(nom); },
      add(nom) { this.valeurs.add(nom); },
      contains(nom) { return this.valeurs.has(nom); },
    },
    ecouteurs,
    addEventListener(type, fn) {
      if (!ecouteurs.has(type)) ecouteurs.set(type, []);
      ecouteurs.get(type).push(fn);
    },
    declenche(type, evenement = {}) {
      for (const fn of (ecouteurs.get(type) || [])) fn(evenement);
    },
    attributs: new Map(),
    setAttribute(nom, valeur) { this.attributs.set(nom, String(valeur)); },
    getAttribute(nom) { return this.attributs.get(nom) ?? null; },
    appendChild() {}, remove() {}, click() {},
  };
}

function installeDOM() {
  // Tous les identifiants reellement presents dans la page : si app.js en
  // demande un qui n'y est pas, on le saura ici et pas en production.
  const declares = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  const elements = new Map(declares.map((id) => [id, faitElement(id)]));
  const reclames = new Set();

  globalThis.document = {
    getElementById(id) {
      reclames.add(id);
      return elements.get(id) || null;
    },
    createElement: () => faitElement(),
    documentElement: faitElement(),
    body: { appendChild() {} },
  };
  globalThis.localStorage = {
    valeurs: new Map(),
    getItem(cle) { return this.valeurs.get(cle) ?? null; },
    setItem(cle, valeur) { this.valeurs.set(cle, valeur); },
    removeItem(cle) { this.valeurs.delete(cle); },
  };
  // navigator existe deja dans Node et n'est pas remplacable : on y greffe
  // seulement ce que la page utilise.
  if (!globalThis.navigator.geolocation) {
    Object.defineProperty(globalThis.navigator, "geolocation", {
      value: { getCurrentPosition() {} }, configurable: true,
    });
  }
  globalThis.URL.createObjectURL = () => "blob:faux";
  globalThis.URL.revokeObjectURL = () => {};
  globalThis.Blob = class { constructor(parties) { this.parties = parties; } };

  const messages = [];
  globalThis.Worker = class {
    constructor(url, options) { this.url = String(url); this.options = options; }
    postMessage(m) { messages.push(m); }
    terminate() {}
  };
  globalThis.messagesWorker = messages;

  const couche = () => ({ addTo() { return this; }, getBounds: () => "bornes" });
  globalThis.L = {
    map: (conteneur) => (globalThis.conteneurCarte = conteneur, {
      _ecouteurs: {},
      on(type, fn) { this._ecouteurs[type] = fn; },
      setView() { return this; }, getZoom: () => 16, fitBounds() {},
      zoomIn() { globalThis.zoomFait = (globalThis.zoomFait || 0) + 1; },
      zoomOut() { globalThis.zoomFait = (globalThis.zoomFait || 0) - 1; },
      removeLayer() {}, addLayer() {},
    }),
    tileLayer: () => couche(),
    control: { layers: () => couche(), scale: () => couche() },
    marker: () => ({ addTo() { return this; }, on() {}, setLatLng() {},
                     getLatLng: () => ({ lat: 47.0, lng: 5.0 }) }),
    divIcon: (o) => o,
    latLng: (lat, lng) => ({ lat, lng }),
    polyline: () => couche(),
  };

  return { elements, reclames };
}

test("l'interface se charge sans erreur, y compris avec des reglages memorises", async () => {
  const { elements, reclames } = installeDOM();
  // Cas le plus fragile : un visiteur qui revient, avec un depart memorise.
  globalThis.localStorage.setItem("generateur-boucle:reglages", JSON.stringify({
    lat: 47.0096, lon: 5.0096, zoom: 16, km: "9", niveau: "tolerant",
    arriveeActive: false,
  }));

  await import(`../docs/js/app.js?t=${Date.now()}`);

  // Chaque identifiant demande par le script existe bien dans la page.
  for (const id of reclames) {
    assert.ok(elements.has(id), `app.js demande #${id}, absent de index.html`);
  }
  // Les reglages memorises ont bien ete appliques.
  assert.equal(elements.get("km").value, "9");
  assert.equal(elements.get("niveau").value, "tolerant");
  assert.ok(reclames.has("btn-generer"));
  // Leaflet resout lui-meme l'identifiant du conteneur : on verifie qu'il
  // recoit bien celui qui existe dans la page.
  assert.equal(globalThis.conteneurCarte, "carte");
  assert.ok(elements.has("carte"), "le conteneur de carte doit exister");
});

test("le worker est bien un module, charge depuis le depot", async () => {
  installeDOM();
  await import(`../docs/js/app.js?t=${Date.now()}`);
  // app.js cree le worker au chargement du module.
  assert.ok(globalThis.messagesWorker, "le worker doit etre instancie");
});

test("effacer les reglages vide le stockage et demande le vidage du cache", async () => {
  const { elements } = installeDOM();
  globalThis.localStorage.setItem("generateur-boucle:reglages", '{"km":"12"}');
  await import(`../docs/js/app.js?t=${Date.now()}`);

  const bouton = elements.get("btn-oublier");
  assert.ok(typeof bouton.onclick === "function", "le bouton doit etre cable");
  bouton.onclick({ preventDefault() {} });

  assert.equal(globalThis.localStorage.getItem("generateur-boucle:reglages"), null);
  assert.ok(globalThis.messagesWorker.some((m) => m.type === "vide-cache"),
    "le cache des donnees OSM doit etre vide lui aussi");
});

test("generer sans depart pose refuse poliment au lieu de planter", async () => {
  const { elements } = installeDOM();
  await import(`../docs/js/app.js?t=${Date.now()}`);
  const bouton = elements.get("btn-generer");
  bouton.onclick();
  assert.ok(/Pose d'abord ton départ/.test(elements.get("message").innerHTML));
  assert.ok(!globalThis.messagesWorker.some((m) => m.type === "generer"),
    "aucun calcul ne doit partir sans point de depart");
});

test("la recherche d'adresse part sur Entree, pas sur la frappe", async () => {
  const { elements } = installeDOM();
  await import(`../docs/js/app.js?t=${Date.now()}`);
  const champ = elements.get("q");
  champ.value = "brest";

  // Frappe : rien ne doit partir.
  champ.declenche("input", {});
  assert.equal(champ.ecouteurs.has("input"), false,
    "aucun ecouteur de frappe ne doit exister sur le champ de recherche");

  // Entree : la recherche demarre (l'appel reseau echouera ici, c'est normal).
  let empeche = false;
  champ.declenche("keydown", { key: "Enter", preventDefault() { empeche = true; } });
  assert.ok(empeche, "la touche Entree doit etre interceptee");
});

test("les boutons de zoom sont cables sur la carte", async () => {
  const { elements } = installeDOM();
  globalThis.zoomFait = 0;
  await import(`../docs/js/app.js?t=${Date.now()}`);
  for (const id of ["zoom-plus", "zoom-moins", "recentrer"]) {
    assert.ok(typeof elements.get(id).onclick === "function", `#${id} non cable`);
  }
  elements.get("zoom-plus").onclick();
  elements.get("zoom-plus").onclick();
  elements.get("zoom-moins").onclick();
  assert.equal(globalThis.zoomFait, 1, "les clics doivent atteindre la carte");
  // Recentrer sans parcours ni depart ne doit pas planter.
  elements.get("recentrer").onclick();
});

test("la poignee replie et deplie le panneau", async () => {
  const { elements } = installeDOM();
  await import(`../docs/js/app.js?t=${Date.now()}`);
  const panneau = elements.get("panneau");
  const poignee = elements.get("poignee");
  assert.ok(typeof poignee.onclick === "function", "la poignee doit etre cablee");

  poignee.onclick();
  assert.ok(panneau.classList.contains("replie"));
  assert.equal(poignee.getAttribute("aria-expanded"), "false");
  poignee.onclick();
  assert.ok(!panneau.classList.contains("replie"));
  assert.equal(poignee.getAttribute("aria-expanded"), "true");
});
