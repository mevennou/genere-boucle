// Le profil dessine.
//
// Un graphique se verifie mal a l'oeil : on regarde une capture, on trouve ça
// joli, et on ne voit pas que deux plages de couleur ne se touchent pas ou que
// l'axe ment d'un facteur deux. Ces tests portent sur la geometrie produite,
// pas sur l'impression qu'elle donne.
import test from "node:test";
import assert from "node:assert/strict";

import {
  svgProfil, legendePentes, indiceEn, positionDe, CADRE,
} from "../docs/js/graphique.js";
import { CLASSES_PENTE, pentes as calculePentes } from "../docs/js/altitude.js";

/** Profil fabrique : une cote, un plat, une descente. */
function profilType(pas = 25) {
  const altitudes = [], distances = [];
  for (let i = 0; i < 120; i++) {
    distances.push(i * pas);
    altitudes.push(i < 40 ? i * 1.5 : i < 80 ? 60 : 60 - (i - 80) * 1.5);
  }
  return {
    distances, altitudes,
    pentes: calculePentes(altitudes, distances),
    montee: 60, descente: 60,
    mini: Math.min(...altitudes), maxi: Math.max(...altitudes),
    longueur: distances[distances.length - 1],
  };
}

const nombres = (d) => (d.match(/-?\d+(\.\d+)?/g) || []).map(Number);

test("profil : le SVG produit est complet et decrit ce qu'il montre", () => {
  const p = profilType();
  const svg = svgProfil(p, { titre: "Profil & relief" });

  assert.ok(svg.startsWith("<svg") && svg.endsWith("</svg>"));
  assert.ok(svg.includes(`viewBox="0 0 ${CADRE.LARGEUR} ${CADRE.HAUTEUR}"`));
  // Accessibilite : le graphique s'annonce, il n'est pas qu'un ornement.
  assert.ok(/role="img"/.test(svg) && /<title>/.test(svg));
  // Et le titre est echappe, pas injecte tel quel.
  assert.ok(svg.includes("Profil &amp; relief"));
  assert.ok(!svg.includes("Profil & relief"));

  // Une courbe, des aires, deux reperes d'altitude, trois graduations.
  assert.equal((svg.match(/class="crete"/g) || []).length, 1);
  assert.ok((svg.match(/class="aire /g) || []).length >= 3,
    "la cote, le plat et la descente doivent au moins se distinguer");
  assert.equal((svg.match(/class="grille"/g) || []).length, 2);
  assert.equal((svg.match(/class="repere"/g) || []).length, 5);
});

test("profil : les plages de couleur sont jointives", () => {
  // Un blanc entre deux plages se lirait comme une portion sans donnees. Le
  // parcours, lui, est continu : chaque plage doit reprendre ou la precedente
  // s'arrete.
  const p = profilType();
  const svg = svgProfil(p);
  const aires = [...svg.matchAll(/<path class="aire [^"]+" d="M([\d.]+) [\d.]+ L(.+?) L([\d.]+) [\d.]+ Z"\/>/g)];
  assert.ok(aires.length >= 3, `seulement ${aires.length} plages`);
  for (let i = 1; i < aires.length; i++) {
    const finPrecedente = Number(aires[i - 1][3]);
    const debut = Number(aires[i][1]);
    assert.ok(Math.abs(debut - finPrecedente) < 0.02,
      `trou de ${(debut - finPrecedente).toFixed(2)} entre deux plages`);
  }
  // La premiere part du bord gauche, la derniere finit au bord droit.
  assert.ok(Math.abs(Number(aires[0][1]) - CADRE.TRACE.x0) < 0.02);
  assert.ok(Math.abs(Number(aires[aires.length - 1][3]) - CADRE.TRACE.x1) < 0.02);
});

test("profil : la courbe tient dans le cadre, axe compris", () => {
  const p = profilType();
  const svg = svgProfil(p);
  const crete = svg.match(/class="crete" points="([^"]+)"/)[1];
  const valeurs = nombres(crete);
  for (let i = 0; i < valeurs.length; i += 2) {
    const [x, y] = [valeurs[i], valeurs[i + 1]];
    assert.ok(x >= CADRE.TRACE.x0 - 0.01 && x <= CADRE.TRACE.x1 + 0.01, `x = ${x}`);
    assert.ok(y >= CADRE.TRACE.y0 - 0.01 && y <= CADRE.TRACE.y1 + 0.01, `y = ${y}`);
  }
  // Les graduations restent sous la courbe, dans la bande qui leur est reservee.
  for (const m of svg.matchAll(/class="repere" x="[\d.]+" y="([\d.]+)"/g)) {
    assert.ok(Number(m[1]) <= CADRE.HAUTEUR, "une graduation deborde du cadre");
  }
});

test("profil : un parcours plat ne se transforme pas en montagne", () => {
  // Sans plancher d'amplitude, trois metres de relief rempliraient la hauteur
  // du graphique et donneraient a un plateau l'allure d'un col.
  const distances = [], altitudes = [];
  for (let i = 0; i < 60; i++) { distances.push(i * 25); altitudes.push(100 + (i % 2) * 1.5); }
  const p = { distances, altitudes, pentes: calculePentes(altitudes, distances),
              montee: 2, descente: 2, mini: 100, maxi: 101.5,
              longueur: distances[distances.length - 1] };
  const svg = svgProfil(p);
  const valeurs = nombres(svg.match(/class="crete" points="([^"]+)"/)[1]);
  const ys = valeurs.filter((_, i) => i % 2 === 1);
  const hauteur = Math.max(...ys) - Math.min(...ys);
  assert.ok(hauteur < (CADRE.TRACE.y1 - CADRE.TRACE.y0) * 0.15,
    `1,5 m de relief occupe ${hauteur.toFixed(0)} points de hauteur`);
});

test("profil : les graduations de distance ont toutes le meme format", () => {
  for (const longueur of [4000, 12000]) {
    const p = profilType();
    p.longueur = longueur;
    p.distances = p.distances.map((_, i) => i * longueur / (p.distances.length - 1));
    const svg = svgProfil(p);
    const textes = [...svg.matchAll(/class="repere"[^>]*>([^<]+)</g)].map((m) => m[1]);
    const graduations = textes.slice(2).map((t) => t.replace(" km", ""));
    const decimales = new Set(graduations.map((t) => (t.split(".")[1] || "").length));
    assert.equal(decimales.size, 1,
      `${longueur} m : graduations ${JSON.stringify(graduations)}`);
  }
});

test("profil : la legende nomme chaque classe, la couleur ne suffit pas", () => {
  const legende = legendePentes();
  assert.equal((legende.match(/<li>/g) || []).length, CLASSES_PENTE.length);
  for (const classe of CLASSES_PENTE) {
    assert.ok(legende.includes(`pastille ${classe.cle}`), `pastille ${classe.cle}`);
    assert.ok(legende.includes(classe.libelle), `libelle ${classe.libelle}`);
  }
});

test("profil : le survol designe le bon echantillon", () => {
  const p = profilType();
  // Bord gauche, milieu, bord droit.
  assert.equal(indiceEn(CADRE.TRACE.x0, p), 0);
  assert.equal(indiceEn(CADRE.TRACE.x1, p), p.distances.length - 1);
  const milieu = indiceEn((CADRE.TRACE.x0 + CADRE.TRACE.x1) / 2, p);
  assert.ok(Math.abs(p.distances[milieu] - p.longueur / 2) <= 25);
  // Hors du trace, rien n'est designe.
  assert.equal(indiceEn(0, p), -1);
  assert.equal(indiceEn(CADRE.LARGEUR + 20, p), -1);

  // Et le point pointe bien sur la courbe.
  const crete = nombres(svgProfil(p).match(/class="crete" points="([^"]+)"/)[1]);
  for (const i of [0, 17, 60, p.distances.length - 1]) {
    const [x, y] = positionDe(i, p);
    assert.ok(Math.abs(x - crete[i * 2]) < 0.02 && Math.abs(y - crete[i * 2 + 1]) < 0.02,
      `echantillon ${i} : le viseur et la courbe ne coincident pas`);
  }
});

test("profil : sans donnees, pas de graphique vide", () => {
  assert.equal(svgProfil(null), "");
  assert.equal(svgProfil({ altitudes: [], distances: [], pentes: [] }), "");
});
