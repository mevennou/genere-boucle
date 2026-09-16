// Detection et prevention des portions doublees.
//
// Le defaut vise : le trace part sur une rue, fait demi-tour et revient par le
// trottoir cartographie a part, douze metres a cote. A l'ecran ce sont deux
// traits paralleles ; dans le graphe ce sont deux aretes distinctes, donc le
// comptage de repetition historique n'y voyait rien.
import test from "node:test";
import assert from "node:assert/strict";
import { lecture } from "./utils.js";
import { reseauCouloir, sourceDe, dlat, dlon } from "./reseaux.js";

import { mesureDoublement, distancePointSegment } from "../docs/js/controle.js";
import { detecteCorridors } from "../docs/js/corridors.js";
import { construitGrapheBrut, contracte, supprimeImpasses, construitCSR } from "../docs/js/graphe.js";
import { Routeur } from "../docs/js/routage.js";
import { genere } from "../docs/js/moteur.js";

// --- geometrie de base ----------------------------------------------------
test("distance d'un point a un segment", () => {
  // Point a 12 m au nord du milieu d'un segment est-ouest.
  const d = distancePointSegment(47 + dlat(12), 5 + dlon(50), 47, 5, 47, 5 + dlon(100));
  assert.ok(Math.abs(d - 12) < 0.5, `${d} m au lieu de 12`);
  // Au-dela de l'extremite, c'est la distance a l'extremite qui compte.
  const e = distancePointSegment(47, 5 + dlon(150), 47, 5, 47, 5 + dlon(100));
  assert.ok(Math.abs(e - 50) < 0.5, `${e} m au lieu de 50`);
  // Segment degenere.
  assert.ok(distancePointSegment(47, 5, 47, 5, 47, 5) === 0);
});

// --- detecteur geometrique ------------------------------------------------
function carrePropre(cote = 800, pas = 20) {
  const p = [], n = cote / pas;
  for (let k = 0; k <= n; k++) p.push([47, 5 + dlon(k * pas)]);
  for (let k = 1; k <= n; k++) p.push([47 + dlat(k * pas), 5 + dlon(cote)]);
  for (let k = 1; k <= n; k++) p.push([47 + dlat(cote), 5 + dlon(cote - k * pas)]);
  for (let k = 1; k <= n; k++) p.push([47 + dlat(cote - k * pas), 5]);
  return p;
}

test("doublement : une boucle propre ne declenche rien", () => {
  const m = mesureDoublement(carrePropre());
  assert.equal(m.longueur, 0);
  assert.equal(m.portions.length, 0);
});

test("doublement : l'aller-retour rue puis trottoir est vu", () => {
  // Exactement le defaut de la capture : 150 m parcourus a l'aller sur une
  // voie, au retour sur une voie parallele 12 m a cote.
  const carre = carrePropre();
  const trace = carre.slice(0, 20);
  for (let k = 1; k <= 8; k++) trace.push([47 - dlat(k * 19), 5 + dlon(380)]);
  for (let k = 8; k >= 1; k--) trace.push([47 - dlat(k * 19), 5 + dlon(392)]);
  trace.push(...carre.slice(20));

  const m = mesureDoublement(trace);
  assert.ok(m.longueur > 150, `seulement ${m.longueur.toFixed(0)} m detectes`);
  assert.ok(m.portions.length >= 2, "les deux passages doivent etre signales");
});

test("doublement : un vrai demi-tour sur la meme voie est vu aussi", () => {
  const carre = carrePropre();
  const trace = [...carre, ...carre.slice(0, 20)];
  assert.ok(mesureDoublement(trace).longueur > 300);
});

test("doublement : ni le bruit ni la fermeture de boucle ne comptent", () => {
  // Deux points voisins au milieu du trace : quelques metres, pas un
  // aller-retour.
  const trace = carrePropre();
  trace.splice(25, 0, [trace[25][0] + dlat(3), trace[25][1]]);
  assert.equal(mesureDoublement(trace).longueur, 0);

  // Le debut et la fin d'une boucle fermee se touchent par construction :
  // l'ecart le long du chemin doit se mesurer dans les deux sens.
  const fermee = [...carrePropre()];
  fermee.push(fermee[0]);
  assert.equal(mesureDoublement(fermee).longueur, 0);

  // Trace trop court : pas de plantage.
  assert.equal(mesureDoublement([[47, 5], [47, 5.001]]).longueur, 0);
});

// --- detection des voies jumelles ----------------------------------------
function grapheDe(voies) {
  const G = construitGrapheBrut(voies, "normal", new Set(), new Set());
  const { aretes, adjacence } = contracte(G.brut, G.nbNoeuds, new Set());
  return { G, aretes, adjacence };
}

test("couloirs : un reseau sans voie parallele reste inchange", () => {
  const { G, aretes } = grapheDe(lecture("reseau.json").voies);
  const { couloir, nbJumelages, nbCouloirs } = detecteCorridors(aretes, G.lat, G.lon);
  assert.equal(nbJumelages, 0, "aucun jumelage attendu sur le damier de reference");
  assert.equal(nbCouloirs, aretes.length, "un couloir par arete");
  for (let i = 0; i < aretes.length; i++) assert.equal(couloir[i], i);
});

test("couloirs : une rue et son trottoir sont regroupes", () => {
  const { G, aretes } = grapheDe(reseauCouloir(200).voies);
  const { couloir, nbJumelages } = detecteCorridors(aretes, G.lat, G.lon);
  assert.ok(nbJumelages >= 2, `seulement ${nbJumelages} jumelages`);

  // Chaque jumelage doit associer une voie pietonne a une rue : c'est bien une
  // chaussee et son trottoir, pas deux morceaux de la meme rue.
  let mixtes = 0;
  for (let i = 0; i < aretes.length; i++) {
    if (couloir[i] === i) continue;
    const a = aretes[i].etiquette, b = aretes[couloir[i]].etiquette;
    if (a !== b) mixtes++;
  }
  assert.ok(mixtes >= 2, "les paires rue/trottoir doivent etre reperees");
});

test("couloirs : deux voies qui se croisent ne sont pas jumelees", () => {
  // Une rue est-ouest et une rue nord-sud qui se coupent : elles partagent un
  // point, rien de plus. Les confondre casserait des itineraires legitimes.
  const voies = [
    { type: "way", id: 1, tags: { highway: "residential", surface: "asphalt" },
      nodes: [1, 2, 3], geometry: [{ lat: 47, lon: 5 }, { lat: 47, lon: 5 + dlon(100) },
                                   { lat: 47, lon: 5 + dlon(200) }] },
    { type: "way", id: 2, tags: { highway: "footway", surface: "asphalt" },
      nodes: [4, 2, 5], geometry: [{ lat: 47 - dlat(100), lon: 5 + dlon(100) },
                                   { lat: 47, lon: 5 + dlon(100) },
                                   { lat: 47 + dlat(100), lon: 5 + dlon(100) }] },
  ];
  const { G, aretes } = grapheDe(voies);
  const { nbJumelages } = detecteCorridors(aretes, G.lat, G.lon);
  assert.equal(nbJumelages, 0, "deux voies secantes ne sont pas des jumelles");
});

// --- effet sur le routage -------------------------------------------------
test("penalite : le trottoir d'a cote est penalise avec sa rue", () => {
  const { voies } = reseauCouloir(200);
  const { G, aretes, adjacence } = grapheDe(voies);
  const coeur = supprimeImpasses(aretes, adjacence, G.nbNoeuds);
  const csr = construitCSR(coeur, G.nbNoeuds);
  const { couloir } = detecteCorridors(aretes, G.lat, G.lon);

  // Une arete qui a une jumelle, et sa jumelle.
  let rue = -1, jumelle = -1;
  for (let i = 0; i < aretes.length && rue < 0; i++) {
    if (couloir[i] !== i) { rue = couloir[i]; jumelle = i; }
  }
  assert.ok(rue >= 0, "le reseau de test doit contenir une paire jumelle");

  const avant = new Routeur(csr, aretes, G.lat, G.lon, G.nbNoeuds, null);
  avant.nouvellesPenalites();
  avant.penalise(rue);
  assert.equal(avant.estPenalisee(jumelle), false,
    "sans couloirs, le trottoir echappait a la penalite");

  const apres = new Routeur(csr, aretes, G.lat, G.lon, G.nbNoeuds, couloir);
  apres.nouvellesPenalites();
  apres.penalise(rue);
  assert.equal(apres.estPenalisee(jumelle), true,
    "avec couloirs, penaliser la rue penalise son trottoir");
});

// --- bout en bout ---------------------------------------------------------
test("bout en bout : plus de portion doublee sur un reseau a trottoirs", async () => {
  for (const longueurCouloir of [150, 200, 300]) {
    const { voies, depart } = reseauCouloir(longueurCouloir);
    for (const km of [4.2, 4.6, 5.0, 5.4]) {
      const r = await genere({
        lat: depart[1], lon: depart[2], cibleM: km * 1000,
        caps: 16, sommets: [3, 4, 5, 6], iterations: 10, source: sourceDe(voies),
      });
      const seuil = Math.max(30, km * 1000 * 0.005);
      assert.ok(r.doublement <= seuil,
        `couloir ${longueurCouloir} m / ${km} km : ${r.doublement.toFixed(0)} m doubles`);
      // Le resultat expose la mesure, pour que l'interface puisse en parler.
      assert.equal(typeof r.doublement, "number");
    }
  }
});

test("bout en bout : quand il n'y a pas d'alternative, c'est dit et non cache", async () => {
  // Une seule orientation : le moteur n'a aucun autre candidat sous la main.
  // Il doit alors signaler le doublement plutot que de le passer sous silence.
  const { voies, depart } = reseauCouloir(200);
  const lignes = [];
  const r = await genere({
    lat: depart[1], lon: depart[2], cibleM: 5000, caps: 1, sommets: [4],
    iterations: 10, source: sourceDe(voies), journal: (l) => lignes.push(l),
  });
  if (r.doublement > 30) {
    assert.ok(lignes.some((l) => /portion doublee/.test(l)),
      "l'utilisateur doit etre prevenu");
    assert.ok(r.repetee > 0,
      "la repetition par couloir doit compter ce que l'ancien comptage ratait");
  }
});

test("performance : le controle ne coute pas la generation", async () => {
  const { voies, depart } = reseauCouloir(200);
  const debut = performance.now();
  await genere({ lat: depart[1], lon: depart[2], cibleM: 5000, caps: 16,
                 sommets: [3, 4, 5, 6], iterations: 10, source: sourceDe(voies) });
  const duree = performance.now() - debut;
  console.log(`      generation avec controle anti-doublement : ${duree.toFixed(0)} ms`);
  assert.ok(duree < 5000, `trop lent : ${duree.toFixed(0)} ms`);
});
