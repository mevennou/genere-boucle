// Conformite du site. Ces tests figent les decisions prises lors de la revue
// juridique : si quelqu'un remet un CDN ou la couche satellite dans six mois,
// la suite echoue au lieu de laisser passer.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(RACINE, "docs");
const lit = (chemin) => readFileSync(join(SITE, chemin), "utf-8");

const fichiersJS = readdirSync(join(SITE, "js")).filter((f) => f.endsWith(".js"));
const toutLeJS = fichiersJS.map((f) => lit(join("js", f))).join("\n");
const html = lit("index.html");

test("tous les modules sont syntaxiquement valides", () => {
  for (const fichier of fichiersJS) {
    execFileSync(process.execPath, ["--check", join(SITE, "js", fichier)]);
  }
  assert.ok(fichiersJS.length >= 8, `seulement ${fichiersJS.length} modules`);
});

test("aucun CDN tiers : tout est servi depuis le depot", () => {
  const interdits = ["cdnjs.cloudflare.com", "unpkg.com", "cdn.jsdelivr.net",
                     "esm.sh", "fonts.googleapis.com", "fonts.gstatic.com",
                     "ajax.googleapis.com"];
  for (const hote of interdits) {
    assert.ok(!html.includes(hote), `index.html appelle encore ${hote}`);
    assert.ok(!toutLeJS.includes(hote), `un module appelle encore ${hote}`);
  }
  assert.ok(html.includes('src="./vendor/leaflet.js"'), "Leaflet doit etre local");
  assert.ok(html.includes('href="./vendor/leaflet.css"'), "le CSS doit etre local");
  assert.ok(existsSync(join(SITE, "vendor", "leaflet.js")));
  assert.ok(existsSync(join(SITE, "vendor", "leaflet.css")));
});

test("Leaflet vendorise conserve sa mention de copyright BSD", () => {
  const leaflet = lit(join("vendor", "leaflet.js")).slice(0, 400);
  assert.ok(/Leaflet/.test(leaflet) && /\(c\)/.test(leaflet),
    "l'en-tete de copyright doit etre conserve");
});

test("pas de couche satellite sous licence commerciale", () => {
  for (const motif of ["arcgisonline", "arcgis", "Maxar", "mapbox", "google"]) {
    assert.ok(!new RegExp(motif, "i").test(toutLeJS),
      `reference a ${motif} : couche retiree lors de la revue juridique`);
  }
});

test("aucun traceur ni mesure d'audience", () => {
  const mouchards = ["google-analytics", "googletagmanager", "gtag(", "plausible",
                     "matomo", "hotjar", "facebook.net", "doubleclick",
                     "sentry", "clarity.ms"];
  for (const mouchard of mouchards) {
    assert.ok(!toutLeJS.includes(mouchard) && !html.includes(mouchard),
      `traceur detecte : ${mouchard}`);
  }
  // Pas de cookie non plus : le stockage local suffit et reste exempte.
  assert.ok(!/document\.cookie/.test(toutLeJS), "aucun cookie ne doit etre pose");
});

test("le stockage local se limite aux reglages et peut etre efface", () => {
  const app = lit(join("js", "app.js"));
  assert.ok(app.includes("localStorage.removeItem"),
    "un bouton doit permettre d'effacer les reglages");
  assert.ok(html.includes("btn-oublier"), "le bouton doit exister dans la page");
  // Les cles stockees restent des reglages, pas un identifiant de visiteur.
  assert.ok(!/localStorage\.setItem\(\s*["'](?!generateur-boucle)/.test(app));
});

test("Nominatim n'est jamais appele a la frappe", () => {
  const app = lit(join("js", "app.js"));
  // La recherche doit partir d'un clic ou d'Entree, jamais d'un evenement input.
  assert.ok(!/champQ\.addEventListener\(\s*["']input["']/.test(app),
    "recherche a la frappe : interdite par la politique d'usage de Nominatim");
  assert.ok(/btn-chercher/.test(app) && /"Enter"/.test(app),
    "la recherche doit se declencher sur validation");
});

test("l'attribution cartographique est presente et jamais masquee", () => {
  const app = lit(join("js", "app.js"));
  assert.ok(app.includes("openstreetmap.org/copyright"),
    "le lien d'attribution OSM est exige par l'ODbL");
  for (const fond of ["OpenStreetMap France", "OpenTopoMap"]) {
    assert.ok(app.includes(fond), `attribution manquante : ${fond}`);
  }
  assert.ok(!/attributionControl:\s*false/.test(app),
    "le controle d'attribution ne doit pas etre desactive");
});

test("l'avertissement de securite s'affiche avec le resultat", () => {
  const app = lit(join("js", "app.js"));
  assert.ok(/avertissement/.test(app) && /dessine\(/.test(app),
    "l'avertissement doit faire partie du bilan affiche");
  const bilan = app.slice(app.indexOf("function dessine"));
  assert.ok(/class="avertissement"/.test(bilan),
    "l'avertissement doit etre dans le bloc de resultat, pas ailleurs");
  assert.ok(/Vérifie le tracé|Verifie le trace/.test(bilan));
});

test("les mentions legales sont accessibles depuis la page", () => {
  assert.ok(html.includes("mentions-legales.html"), "lien manquant en pied de page");
  assert.ok(existsSync(join(SITE, "mentions-legales.html")),
    "la page de mentions legales doit etre publiee avec le site");
  const legales = lit("mentions-legales.html");
  for (const exige of ["GitHub, Inc.", "88 Colin P. Kelly", "ODbL",
                       "mevennou", "CNIL"]) {
    assert.ok(legales.includes(exige), `mention manquante : ${exige}`);
  }

  // Aucun gabarit non rempli ne doit partir en ligne.
  for (const gabarit of ["CONTACT", "ADRESSE-DU-SITE", "À compléter",
                         "TODO", "XXX"]) {
    assert.ok(!legales.includes(gabarit),
      `gabarit non rempli dans les mentions legales : ${gabarit}`);
  }
  // Un moyen de contact doit exister et ne pas exposer d'adresse personnelle.
  assert.ok(/mailto:|\/issues/.test(legales), "aucun moyen de contact indique");
  assert.ok(!/laposte\.net|gmail\.com|@orange\.fr/i.test(legales),
    "une adresse personnelle ne doit jamais figurer sur le site");
});

test("la page reste utilisable sans JavaScript, au moins pour l'expliquer", () => {
  assert.ok(html.includes("<noscript>"), "il faut un repli sans JavaScript");
  assert.ok(html.includes("lang=\"fr\""));
  assert.ok(html.includes('name="viewport"'), "la page doit tenir sur mobile");
});

test("aucune cle d'API ni secret dans le depot", () => {
  const suspects = [/api[_-]?key\s*[:=]\s*["'][A-Za-z0-9]{8,}/i,
                    /token\s*[:=]\s*["'][A-Za-z0-9]{16,}/i,
                    /Bearer\s+[A-Za-z0-9._-]{16,}/];
  for (const motif of suspects) {
    assert.ok(!motif.test(toutLeJS), `secret potentiel : ${motif}`);
  }
});
