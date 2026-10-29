// Les deux defauts signales sur le site, rejoues sur un vrai reseau.
//
// « J'ai voulu faire une boucle de 10 km, il m'en donne 9 » : le repli
// anti-doublement pouvait s'ecarter de la cible d'un cinquieme de plus que le
// meilleur candidat, des que celui-ci avait le moindre defaut de dessin. Et
// la regle donnee depuis : cinq cents metres de plus plutot que cinquante de
// moins.
//
// « Il me fait passer sur des routes dangereuses, sans voie pietonne » : une
// route de campagne a 80 km/h coutait moins cher qu'un sentier nomme, et
// l'A* la prenait des qu'elle raccourcissait.
//
// La fixture brest-ouest.json.gz est une extraction Overpass de 4,5 km de
// rayon autour du Technopole de Brest — assez pour porter une boucle de
// 10 km, ce que brest.json (2,6 km) ne peut pas. Comme elle, elle ne garde
// que les tags lus par les regles et des coordonnees au millionieme ; elle
// est compressee pour ne pas alourdir le depot de deux megaoctets.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { genere } from "../docs/js/moteur.js";

const ICI = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(gunzipSync(
  readFileSync(join(ICI, "fixtures", "brest-ouest.json.gz"))));
const source = {
  reseau: async () => fixture.voies,
  itineraires: async () => new Set(fixture.balises),
  barrieres: async () => [],
};

// Tags de la voie qui porte chaque segment du reseau, dans les deux sens.
const parSegment = new Map();
const cle = (a, b) => `${a[0]},${a[1]}|${b[0]},${b[1]}`;
for (const voie of fixture.voies) {
  const g = voie.geometry;
  for (let k = 0; k + 1 < g.length; k++) {
    const a = [g[k].lat, g[k].lon], b = [g[k + 1].lat, g[k + 1].lon];
    parSegment.set(cle(a, b), voie.tags);
    parSegment.set(cle(b, a), voie.tags);
  }
}

// Volontairement redit ici plutot qu'emprunte aux regles : le test doit
// pouvoir contredire le code qu'il verifie.
function routeDeCampagneSansTrottoir(tags) {
  const partagee = ["unclassified", "tertiary", "secondary", "road"]
    .some((hw) => tags.highway === hw || tags.highway === `${hw}_link`);
  if (!partagee) return false;
  const trottoir = ["sidewalk", "sidewalk:both", "sidewalk:left", "sidewalk:right"]
    .some((k) => ["yes", "both", "left", "right", "separate"].includes(tags[k]));
  if (trottoir || tags.foot === "designated") return false;
  const limite = tags.maxspeed || tags["maxspeed:type"] || tags["zone:maxspeed"]
              || tags["source:maxspeed"] || "";
  return /rural/i.test(limite) || parseFloat(limite) >= 70;
}

// Departs choisis au coeur de l'extraction, pour qu'une boucle de 10 km ne
// bute pas sur son bord. Le dernier rendait 10,96 km pour 10.
const DEPARTS = [[48.3602, -4.5712], [48.368, -4.58], [48.372, -4.555]];
const DISTANCES = [8, 10];

const resultats = [];
for (const [lat, lon] of DEPARTS) {
  for (const km of DISTANCES) {
    resultats.push({ lat, lon, km, r: await genere({
      lat, lon, cibleM: km * 1000, niveau: "normal", source,
    }) });
  }
}

test("reseau etendu : jamais moins que la distance demandee", () => {
  // Cinq cents metres de plus plutot que cinquante de moins : au plus 0,5 %
  // de manque, au plus 5 % de trop.
  for (const { lat, lon, km, r } of resultats) {
    const ecart = (r.distance - km * 1000) / (km * 1000);
    assert.ok(ecart >= -0.005 && ecart <= 0.05,
      `${lat},${lon} ${km} km : ${(r.distance / 1000).toFixed(2)} km rendus `
      + `(${(ecart * 100).toFixed(1)} %)`);
    assert.equal(r.tours, 1, "une seule boucle suffit sur ce reseau");
  }
});

test("reseau etendu : aucune route de campagne sans trottoir", () => {
  for (const { lat, lon, km, r } of resultats) {
    let segments = 0;
    const routes = new Set();
    for (let k = 0; k + 1 < r.points.length; k++) {
      const tags = parSegment.get(cle(r.points[k], r.points[k + 1]));
      if (!tags || !routeDeCampagneSansTrottoir(tags)) continue;
      segments += 1;
      routes.add(tags.name || tags.highway);
    }
    assert.equal(segments, 0,
      `${lat},${lon} ${km} km passe par ${[...routes].join(", ")}`);
  }
});

test("reseau etendu : le trace ne quitte jamais le reseau", () => {
  // Chaque pas du trace doit etre un segment d'une voie. L'effacement des
  // lacets coupait une boucle refermee a quelques metres sans raccorder les
  // deux bouts : le GPX tracait alors un trait droit a travers champs, que la
  // montre suivait.
  for (const { lat, lon, km, r } of resultats) {
    for (let k = 0; k + 1 < r.points.length; k++) {
      assert.ok(parSegment.has(cle(r.points[k], r.points[k + 1])),
        `${lat},${lon} ${km} km : saut hors reseau entre `
        + `${r.points[k]} et ${r.points[k + 1]}`);
    }
  }
});
