// Relief : decodage des tuiles, echantillonnage, lissage et denivele.
//
// Le denivele est le chiffre qu'on regarde en premier et celui qu'il est le
// plus facile de se tromper : un modele de terrain a quelques metres d'erreur
// verticale, et sans lissage ce bruit s'additionne a chaque pas jusqu'a
// tripler le resultat. Les tests ci-dessous mesurent donc sur des terrains
// dont on connait la reponse exacte.
import test from "node:test";
import assert from "node:assert/strict";

import {
  decodePixel, pixelMonde, altitudeEn, echantillonne, lisse, denivele,
  classePente, CLASSES_PENTE, profil, tuilesNecessaires,
} from "../docs/js/altitude.js";

const COTE = 256;
const ZOOM = 13;

/** Inverse de pixelMonde : sert a fabriquer un terrain connu. */
function latLonDe(wx, wy, zoom = ZOOM) {
  const n = Math.pow(2, zoom) * COTE;
  const lon = wx / n * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * wy / n))) * 180 / Math.PI;
  return [lat, lon];
}

/** Fabrique un chargeur de tuiles dont l'altitude suit `relief(lat, lon)`. */
function terrain(relief) {
  return async (x, y, zoom = ZOOM) => {
    const tuile = new Float32Array(COTE * COTE);
    for (let iy = 0; iy < COTE; iy++) {
      for (let ix = 0; ix < COTE; ix++) {
        const [lat, lon] = latLonDe(x * COTE + ix + 0.5, y * COTE + iy + 0.5, zoom);
        tuile[iy * COTE + ix] = relief(lat, lon);
      }
    }
    return tuile;
  };
}

// --- decodage -------------------------------------------------------------
test("relief : le codage Terrarium se decode exactement", () => {
  // Le zero du format est (128, 0, 0) : 128 x 256 - 32768.
  assert.equal(decodePixel(128, 0, 0), 0);
  assert.equal(decodePixel(128, 100, 0), 100);
  assert.equal(decodePixel(127, 156, 0), -100);
  // Le canal bleu porte les fractions de metre.
  assert.equal(decodePixel(128, 10, 128), 10.5);
  // Point le plus bas et le plus haut du globe, dans les bornes du format.
  assert.ok(decodePixel(126, 0, 0) < -400);
  assert.ok(decodePixel(162, 0, 0) > 8000);
});

test("relief : la projection tombe sur la bonne tuile", () => {
  // Tuile calculee independamment pour le Technopole de Brest.
  const [wx, wy] = pixelMonde(48.3602, -4.5712, 12);
  assert.equal(Math.floor(wx / COTE), 1995);
  assert.equal(Math.floor(wy / COTE), 1417);
  // Aller-retour par l'inverse, au pixel pres.
  const [lat, lon] = latLonDe(...pixelMonde(48.3602, -4.5712, ZOOM), ZOOM);
  assert.ok(Math.abs(lat - 48.3602) < 1e-9 && Math.abs(lon + 4.5712) < 1e-9);
});

test("relief : l'interpolation lit un plan incline sans le deformer", async () => {
  // Terrain en pente reguliere : l'interpolation doit rendre la valeur exacte
  // a la resolution du modele pres.
  const pente = (lat) => (lat - 48.36) * 111320 * 0.05;   // 5 % vers le nord
  const chargeur = terrain(pente);
  const tuiles = new Map();
  const points = [[48.360, -4.571], [48.365, -4.571]];
  for (const cle of tuilesNecessaires(points)) {
    const [z, x, y] = cle.split("/").map(Number);
    tuiles.set(cle, await chargeur(x, y, z));
  }
  for (const lat of [48.3605, 48.3620, 48.3641]) {
    const lu = altitudeEn(lat, -4.571, tuiles);
    assert.ok(Math.abs(lu - pente(lat)) < 1.0,
      `${lu.toFixed(2)} m au lieu de ${pente(lat).toFixed(2)} m`);
  }
  // Hors des tuiles chargees, on ne devine pas.
  assert.equal(altitudeEn(0, 0, tuiles), null);
});

// --- echantillonnage et lissage ------------------------------------------
test("relief : le trace est reechantillonne a pas constant le long du chemin", () => {
  const points = [[47, 5], [47.009, 5], [47.009, 5.013]];
  const { points: e, distances } = echantillonne(points, 25);
  assert.equal(e.length, distances.length);
  // Le long du chemin, tous les pas font exactement 25 m sauf le dernier.
  for (let i = 1; i < distances.length - 1; i++) {
    assert.ok(Math.abs(distances[i] - distances[i - 1] - 25) < 1e-9,
      `pas de ${(distances[i] - distances[i - 1]).toFixed(2)} m`);
  }
  // A vol d'oiseau, les echantillons ne sont jamais plus ecartes que le pas :
  // aux coudes ils sont plus proches, jamais plus loin. C'est ce decalage qui
  // impose de compter la distance le long du chemin.
  const vol = (a, b) => Math.hypot((b[0] - a[0]) * 111320,
    (b[1] - a[1]) * 111320 * Math.cos(a[0] * Math.PI / 180));
  for (let i = 1; i < e.length; i++) {
    assert.ok(vol(e[i - 1], e[i]) <= 25 + 1e-6,
      `echantillons ecartes de ${vol(e[i - 1], e[i]).toFixed(2)} m`);
  }
  assert.ok(e.some((p, i) => i > 0 && vol(e[i - 1], p) < 24.5),
    "au moins un echantillon doit enjamber le coude");

  assert.ok(e.length > 70, `seulement ${e.length} echantillons`);
  // Longueur totale coherente avec le trace d'origine.
  const attendu = vol(points[0], points[1]) + vol(points[1], points[2]);
  assert.ok(Math.abs(distances[distances.length - 1] - attendu) < 1e-6);
  // Un trace degenere ne doit pas planter.
  assert.deepEqual(echantillonne([[47, 5]], 25).points, [[47, 5]]);
});

test("relief : le seuil d'accumulation ecarte le bruit sans raboter les cotes", () => {
  // Terrain plat vu par un modele a +/- 2 m. Additionner naivement les
  // differences donne des centaines de metres de denivele imaginaire : c'est
  // le piege principal de cette fonctionnalite.
  const bruit = [];
  let graine = 7;
  for (let i = 0; i < 400; i++) {
    graine = (graine * 1103515245 + 12345) % 2147483648;
    bruit.push(100 + (graine / 2147483648 - 0.5) * 4);
  }
  const naif = (a) => a.slice(1).reduce((s, v, i) => s + Math.max(0, v - a[i]), 0);
  assert.ok(naif(bruit) > 200, "le terrain de test doit bien etre bruite");
  assert.equal(denivele(bruit, 3).montee, 0,
    "un plateau ne doit produire aucun denivele");
  // Une moyenne glissante ne suffirait pas : elle en laisse passer des
  // dizaines de metres. C'est pour cela qu'elle ne sert qu'au dessin.
  assert.ok(naif(lisse(bruit, 9)) > 20,
    "si le lissage suffisait, le seuil serait inutile — verifier l'hypothese");

  // Une vraie cote de 50 m survit, a un seuil pres.
  const cote = Array.from({ length: 200 }, (_, i) => Math.min(50, i * 0.5));
  const { montee, descente } = denivele(cote, 3);
  assert.ok(montee > 50 - 3 && montee <= 50, `cote rendue ${montee.toFixed(1)} m`);
  assert.equal(descente, 0);

  // Et le lissage, lui, ne doit pas deformer une pente reguliere.
  const droite = Array.from({ length: 50 }, (_, i) => i);
  const lissee = lisse(droite, 3);
  for (let i = 1; i < lissee.length - 1; i++) {
    assert.ok(Math.abs(lissee[i] - droite[i]) < 1e-9);
  }
  assert.deepEqual(lisse(droite, 1), droite, "fenetre de 1 : aucun lissage");
});

// --- classes de pente -----------------------------------------------------
test("relief : les classes de pente couvrent toute l'echelle, sans trou", () => {
  assert.equal(CLASSES_PENTE.length, 5, "echelle divergente : deux bras et un plat");
  assert.equal(classePente(-20).cle, "descente-forte");
  assert.equal(classePente(-8).cle, "descente-forte");
  assert.equal(classePente(-5).cle, "descente");
  assert.equal(classePente(0).cle, "plat");
  assert.equal(classePente(3).cle, "plat");
  assert.equal(classePente(5).cle, "montee");
  assert.equal(classePente(30).cle, "montee-forte");
  // Symetrie : le plat est centre sur zero.
  assert.equal(classePente(-3).cle, "descente");
  assert.equal(classePente(-2.9).cle, "plat");
});

// --- profil complet -------------------------------------------------------
test("relief : le denivele d'une cote connue est rendu exactement", async () => {
  // Trace qui monte de 48.360 a 48.365 (environ 556 m) sur une pente de 5 %,
  // puis redescend : 27,8 m de denivele dans chaque sens.
  const relief = (lat) => (lat - 48.36) * 111320 * 0.05;
  const points = [[48.360, -4.571], [48.365, -4.571], [48.360, -4.571]];
  const p = await profil(points, { chargeur: terrain(relief) });

  const attendu = (48.365 - 48.36) * 111320 * 0.05;
  // Le seuil coute au plus 3 m par versant, et jamais davantage.
  for (const [nom, valeur] of [["montee", p.montee], ["descente", p.descente]]) {
    assert.ok(valeur <= attendu + 0.5 && valeur >= attendu - 3.5,
      `${nom} ${valeur.toFixed(1)} m au lieu de ${attendu.toFixed(1)}`);
  }
  assert.ok(Math.abs(p.maxi - p.mini - attendu) < 2, "amplitude");
  assert.ok(Math.abs(p.longueur - 2 * 556) < 30,
    `longueur ${p.longueur.toFixed(0)} m`);
  assert.equal(p.distances.length, p.altitudes.length);
  assert.equal(p.pentes.length, p.altitudes.length - 1);
  // La pente mesuree doit retrouver les 5 % du terrain.
  const mediane = [...p.pentes].map(Math.abs).sort((a, b) => a - b)[Math.floor(p.pentes.length / 2)];
  assert.ok(Math.abs(mediane - 5) < 1, `pente mediane ${mediane.toFixed(2)} %`);
});

test("relief : un terrain plat ne fabrique pas de denivele", async () => {
  const points = [[48.360, -4.571], [48.362, -4.575], [48.360, -4.571]];
  const p = await profil(points, { chargeur: terrain(() => 42) });
  assert.ok(p.montee < 0.5 && p.descente < 0.5,
    `${p.montee.toFixed(1)} m de denivele sur un plateau`);
  // L'interpolation bilineaire travaille en flottant : 42 reste 42 a l'epsilon
  // pres, pas au bit pres.
  assert.ok(Math.abs(p.mini - 42) < 1e-4 && Math.abs(p.maxi - 42) < 1e-4);
});

test("relief : sans tuile, le profil manque mais rien ne plante", async () => {
  const points = [[48.360, -4.571], [48.365, -4.571]];
  assert.equal(await profil(points, { chargeur: async () => null }), null);
  assert.equal(await profil([[48.36, -4.57]], { chargeur: terrain(() => 0) }), null);
  assert.equal(await profil(null), null);
});
