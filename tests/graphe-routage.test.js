// Graphe, routage et fichiers produits.
import test from "node:test";
import assert from "node:assert/strict";
import { lecture } from "./utils.js";

import {
  construitGrapheBrut, contracte, supprimeImpasses, composante, restreint,
  construitCSR, IndexSpatial,
} from "../docs/js/graphe.js";
import { noeudsInfranchissables } from "../docs/js/regles.js";
import { Routeur, PENALITE } from "../docs/js/routage.js";
import { noteBoucle, compareNote, viragesSerres, polyligneDuTrajet } from "../docs/js/boucle.js";
import { allege, ecritGPX, ecritGeoJSON, nomHorodate, nomTrace } from "../docs/js/sortie.js";
import { distanceHaversine } from "../docs/js/geo.js";

// --- petit reseau fabrique a la main, lisible -----------------------------
// Un carre A-B-C-D avec une antenne E accrochee en B, et un ilot F-G isole.
function voieSimple(id, noeuds, tags = { highway: "footway", surface: "asphalt" }) {
  return {
    type: "way", id, tags,
    nodes: noeuds.map((n) => n[0]),
    geometry: noeuds.map((n) => ({ lat: n[1], lon: n[2] })),
  };
}
const A = [1, 48.0000, 2.0000], B = [2, 48.0000, 2.0020];
const C = [3, 48.0015, 2.0020], D = [4, 48.0015, 2.0000];
const E = [5, 48.0000, 2.0035];                       // antenne
const F = [6, 48.0100, 2.0100], G = [7, 48.0100, 2.0120];  // ilot isole

const carre = [
  voieSimple(10, [A, B]), voieSimple(11, [B, C]),
  voieSimple(12, [C, D]), voieSimple(13, [D, A]),
  voieSimple(14, [B, E]),
  voieSimple(15, [F, G]),
];

function grapheDe(voies, niveau = "normal", bloques = new Set()) {
  return construitGrapheBrut(voies, niveau, new Set(), bloques);
}

test("graphe brut : aretes symetriques, voies refusees absentes", () => {
  const G1 = grapheDe(carre);
  assert.equal(G1.retenues, 6);
  // Chaque arete existe dans les deux sens.
  for (let u = 0; u < G1.nbNoeuds; u++) {
    for (const [v] of (G1.brut[u] || [])) {
      assert.ok(G1.brut[v].some(([w]) => w === u), `arete ${u}-${v} non symetrique`);
    }
  }
  // Une voie interdite n'apporte aucun noeud exploitable.
  const G2 = grapheDe([voieSimple(20, [A, B], { highway: "motorway" })]);
  assert.equal(G2.retenues, 0);
  assert.equal(G2.nbAvecAretes, 0);

  // Geometrie incoherente : ignoree plutot que source d'erreur.
  const bancale = { type: "way", id: 21, tags: { highway: "footway" },
                    nodes: [1, 2, 3], geometry: [{ lat: 48, lon: 2 }] };
  assert.equal(grapheDe([bancale]).retenues, 0);
});

test("graphe brut : un noeud bloque coupe le chemin", () => {
  // Portail infranchissable pose sur B : les aretes qui le touchent sautent.
  const G1 = grapheDe(carre, "normal", new Set([2]));
  const iB = G1.indexDe.get(2);
  assert.ok(!G1.brut[iB], "aucune arete ne doit toucher le noeud bloque");
  // Le reste du carre survit.
  assert.ok(G1.brut[G1.indexDe.get(3)]);
});

test("barrieres : ce qui coupe et ce qui se contourne", () => {
  const bloques = noeudsInfranchissables([
    { type: "node", id: 1, tags: { barrier: "wall" } },
    { type: "node", id: 2, tags: { barrier: "gate" } },
    { type: "node", id: 3, tags: { barrier: "gate", locked: "yes" } },
    { type: "node", id: 4, tags: { barrier: "gate", access: "private" } },
    { type: "node", id: 5, tags: { barrier: "fence", foot: "yes" } },
    { type: "node", id: 6, tags: { barrier: "bollard" } },
    { type: "node", id: 7, tags: {} },
  ]);
  assert.deepEqual([...bloques].sort((a, b) => a - b), [1, 3, 4]);
});

test("contraction : une chaine devient une arete, la geometrie est gardee", () => {
  // Cinq noeuds alignes : trois de degre 2 au milieu.
  const points = [];
  for (let i = 0; i < 5; i++) points.push([100 + i, 48.0, 2.0 + i * 0.001]);
  const G1 = grapheDe([voieSimple(30, points)]);
  const { aretes } = contracte(G1.brut, G1.nbNoeuds, new Set());

  assert.equal(aretes.length, 1, "une seule arete apres contraction");
  assert.equal(aretes[0].polyligne.length, 5, "les 5 points sont conserves");

  // La longueur contractee vaut bien la somme des segments.
  let attendue = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    attendue += distanceHaversine(points[i][1], points[i][2],
                                  points[i + 1][1], points[i + 1][2]);
  }
  assert.ok(Math.abs(aretes[0].longueur - attendue) < 1e-9);

  // Un noeud protege reste une jonction : la chaine est alors coupee en deux.
  const milieu = G1.indexDe.get(102);
  const protege = contracte(G1.brut, G1.nbNoeuds, new Set([milieu]));
  assert.equal(protege.aretes.length, 2);
});

test("contraction : un noeud de degre 2 quitte l'adjacence mais reste dessine", () => {
  // Propriete subtile et volontaire : apres contraction, seuls les carrefours
  // sont des noeuds du graphe. Les points intermediaires ne sont plus
  // routables, mais leur geometrie est conservee dans la polyligne de l'arete.
  const G1 = grapheDe(carre);
  const { aretes, adjacence } = contracte(G1.brut, G1.nbNoeuds, new Set());
  const iA = G1.indexDe.get(1), iB = G1.indexDe.get(2);

  assert.ok(adjacence[iB], "B est un carrefour : il reste un noeud");
  assert.ok(!adjacence[iA], "A est de degre 2 : il sort de l'adjacence");
  const boucle = aretes.find((a) => a.u === iB && a.v === iB);
  assert.ok(boucle, "le carre devient une arete refermee sur B");
  assert.ok([...boucle.polyligne].includes(iA), "A reste dans la polyligne");
});

test("2-coeur : les impasses disparaissent, le maillage reste", () => {
  const G1 = grapheDe(carre);
  const { aretes, adjacence } = contracte(G1.brut, G1.nbNoeuds, new Set());
  const coeur = supprimeImpasses(aretes, adjacence, G1.nbNoeuds);

  const iE = G1.indexDe.get(5), iF = G1.indexDe.get(6);
  const iG = G1.indexDe.get(7), iB = G1.indexDe.get(2);
  assert.ok(!coeur[iE], "l'antenne E doit disparaitre");
  assert.ok(!coeur[iF] && !coeur[iG], "l'ilot isole F-G doit disparaitre");
  assert.ok(coeur[iB], "le carre doit survivre");

  // Le carre survit sous forme d'une arete refermee sur B, donc deux
  // demi-aretes, et l'antenne vers E a bien ete coupee.
  assert.equal(coeur[iB].length, 2);
  assert.ok(coeur[iB].every(([v]) => v === iB));

  // Elagage en cascade : une antenne de trois noeuds saute entierement.
  const queue = [
    ...carre,
    voieSimple(40, [E, [8, 48.0000, 2.0050]]),
    voieSimple(41, [[8, 48.0000, 2.0050], [9, 48.0000, 2.0065]]),
  ];
  const G2 = grapheDe(queue);
  const c2 = contracte(G2.brut, G2.nbNoeuds, new Set());
  const coeur2 = supprimeImpasses(c2.aretes, c2.adjacence, G2.nbNoeuds);
  for (const id of [5, 8, 9]) {
    assert.ok(!coeur2[G2.indexDe.get(id)], `noeud ${id} devait etre elague`);
  }
  assert.ok(coeur2[G2.indexDe.get(2)], "le carre survit malgre la longue queue");
});

test("composante : deux ilots ne se melangent pas", () => {
  // Un deuxieme carre, ailleurs, relie a rien : il ne doit pas etre atteint.
  const H = [20, 48.05, 2.05], I = [21, 48.05, 2.052];
  const J = [22, 48.052, 2.052], K = [23, 48.052, 2.05];
  const ailleurs = [...carre, voieSimple(50, [H, I]), voieSimple(51, [I, J]),
                    voieSimple(52, [J, K]), voieSimple(53, [K, H]),
                    voieSimple(54, [I, [24, 48.05, 2.055]])];
  const G1 = grapheDe(ailleurs);
  const { adjacence } = contracte(G1.brut, G1.nbNoeuds, new Set());

  const depuisB = composante(adjacence, G1.indexDe.get(2));
  assert.ok(depuisB.has(G1.indexDe.get(2)));
  assert.ok(!depuisB.has(G1.indexDe.get(21)), "l'autre carre est un autre ilot");

  const reduite = restreint(adjacence, depuisB, G1.nbNoeuds);
  assert.ok(!reduite[G1.indexDe.get(21)]);
  assert.ok(reduite[G1.indexDe.get(2)]);
});

test("index spatial : trouve le noeud le plus proche, et pas au-dela du rayon", () => {
  const G1 = grapheDe(carre);
  const noeuds = [];
  for (let n = 0; n < G1.nbNoeuds; n++) if (G1.brut[n]) noeuds.push(n);
  const index = new IndexSpatial(G1.lat, G1.lon, noeuds);

  const [proche, distance] = index.plusProche(48.0001, 2.0001);
  assert.equal(proche, G1.indexDe.get(1), "A est le plus proche");
  assert.ok(distance < 20);

  // Trop loin : rien ne doit remonter.
  const [rien] = index.plusProche(49.5, 3.5, 100);
  assert.equal(rien, null);
});

// --- routage --------------------------------------------------------------
// Damier 6x6 pour disposer de vrais choix d'itineraire.
function damier(n = 6, pas = 0.0012) {
  const grille = [], voies = [];
  let id = 1;
  for (let i = 0; i < n; i++) {
    grille.push([]);
    for (let j = 0; j < n; j++) grille[i].push([id++, 48 + i * pas, 2 + j * pas]);
  }
  for (let i = 0; i < n; i++) voies.push(voieSimple(1000 + i, grille[i]));
  for (let j = 0; j < n; j++) {
    voies.push(voieSimple(2000 + j, grille.map((ligne) => ligne[j])));
  }
  return { grille, voies };
}

function prepare(voies) {
  const G1 = grapheDe(voies);
  const { aretes, adjacence } = contracte(G1.brut, G1.nbNoeuds, new Set());
  const coeur = supprimeImpasses(aretes, adjacence, G1.nbNoeuds);
  const routeur = new Routeur(construitCSR(coeur, G1.nbNoeuds), aretes,
                              G1.lat, G1.lon, G1.nbNoeuds);
  return { G: G1, aretes, adjacence, coeur, routeur };
}

test("A* : trouve le plus court chemin et sait dire qu'il n'y en a pas", () => {
  const pas = 0.0012;
  const { grille, voies } = damier(6, pas);
  const { G: G1, routeur } = prepare(voies);
  // Carrefours interieurs : les coins, de degre 2, sont absorbes par la
  // contraction et ne sont donc pas des noeuds routables.
  const depart = G1.indexDe.get(grille[1][1][0]);
  const arrivee = G1.indexDe.get(grille[4][4][0]);

  const [, trajet] = routeur.plusCourtChemin(depart, arrivee);
  const longueur = routeur.longueurTrajet(trajet);

  // Sur un damier, tout escalier monotone a la meme longueur : trois pas en
  // latitude plus trois pas en longitude.
  const attendue = distanceHaversine(48 + pas, 2 + pas, 48 + 4 * pas, 2 + pas)
                 + distanceHaversine(48 + 4 * pas, 2 + pas, 48 + 4 * pas, 2 + 4 * pas);
  assert.ok(Math.abs(longueur - attendue) / attendue < 0.01,
    `longueur ${longueur.toFixed(0)} m contre ${attendue.toFixed(0)} m attendus`);

  // Depart = arrivee.
  assert.deepEqual(routeur.plusCourtChemin(depart, depart), [0.0, []]);

  // Vers un point d'un autre ilot : injoignable, et on le dit. Identifiants
  // hors de la plage du damier, qui numerote ses noeuds a partir de 1.
  const P = [990001, 48.5, 2.5], Q = [990002, 48.5, 2.502];
  const isole = prepare([...voies, voieSimple(9000, [P, Q])]);
  assert.equal(
    isole.routeur.plusCourtChemin(isole.G.indexDe.get(grille[1][1][0]),
                                  isole.G.indexDe.get(990001)),
    null);
});

test("A* : la penalite detourne vraiment le trace", () => {
  const { grille, voies } = damier();
  const { G: G1, routeur } = prepare(voies);
  const depart = G1.indexDe.get(grille[1][1][0]);
  const arrivee = G1.indexDe.get(grille[1][4][0]);

  routeur.nouvellesPenalites();
  const [, direct] = routeur.plusCourtChemin(depart, arrivee);
  const longueurDirecte = routeur.longueurTrajet(direct);

  // On penalise tout ce que le trajet direct emprunte : le suivant doit
  // passer ailleurs, donc etre plus long.
  for (const [index] of direct) routeur.penalise(index);
  const [, detour] = routeur.plusCourtChemin(depart, arrivee);
  const longueurDetour = routeur.longueurTrajet(detour);

  assert.ok(longueurDetour > longueurDirecte,
    "le trajet penalise doit etre plus long");
  const memes = direct.filter(([i]) => detour.some(([j]) => j === i)).length;
  assert.ok(memes < direct.length, "il doit rester des aretes evitees");

  // Nouvelle serie : les penalites precedentes sont oubliees.
  routeur.nouvellesPenalites();
  const [, rejoue] = routeur.plusCourtChemin(depart, arrivee);
  assert.ok(Math.abs(routeur.longueurTrajet(rejoue) - longueurDirecte) < 1e-9);
  assert.equal(PENALITE, 12.0);
});

test("rejointCoeur : sort d'une impasse par le reseau", () => {
  const { grille, voies } = damier();
  // Antenne de deux segments accrochee au coin bas gauche.
  const bout1 = [7001, 48 - 0.0005, 2];
  const bout2 = [7002, 48 - 0.0011, 2];
  const avecQueue = [...voies, voieSimple(7000, [grille[0][0], bout1]),
                     voieSimple(7003, [bout1, bout2])];
  const { G: G1, adjacence, coeur, routeur } = prepare(avecQueue);

  const fond = G1.indexDe.get(7002);
  assert.ok(!coeur[fond], "le fond de l'impasse est hors du coeur");
  const [noeud, trajet] = routeur.rejointCoeur(adjacence, fond, (n) => Boolean(coeur[n]));
  assert.equal(noeud, G1.indexDe.get(grille[0][0][0]));
  assert.ok(routeur.longueurTrajet(trajet) > 100);
});

// --- notation -------------------------------------------------------------
test("note de boucle : parite avec Python, notes et classement", () => {
  const { notes, paires } = lecture("note_boucle.json");
  for (const c of notes) {
    const [longueur, repetee, cible, tolerance, virages] = c.entree;
    const note = noteBoucle(longueur, repetee, cible, tolerance, virages);
    assert.equal(note.length, c.note.length);
    for (let i = 0; i < note.length; i++) {
      assert.ok(Math.abs(note[i] - c.note[i]) < 1e-12,
        `note[${i}] : ${note[i]} contre ${c.note[i]}`);
    }
  }
  // Le classement relatif est ce qui decide de la boucle retenue.
  for (const p of paires) {
    const na = noteBoucle(...notes[p.a].entree);
    const nb = noteBoucle(...notes[p.b].entree);
    assert.equal(Math.sign(compareNote(na, nb)), p.ordre);
  }
});

test("note de boucle : dans la tolerance, la repetition l'emporte", () => {
  // Deux boucles a 1 % de la cible : celle qui se repete le moins gagne.
  const propre = noteBoucle(10100, 0, 10000, 0.03, 1);
  const sale = noteBoucle(10000, 900, 10000, 0.03, 1);
  assert.ok(compareNote(propre, sale) < 0,
    "une boucle exacte mais repetitive ne doit pas gagner");

  // Hors tolerance, c'est la distance qui prime.
  const loin = noteBoucle(14000, 0, 10000, 0.03, 0);
  const proche = noteBoucle(10200, 300, 10000, 0.03, 0);
  assert.ok(compareNote(proche, loin) < 0);

  // A egalite parfaite, le zigzag departage.
  const droit = noteBoucle(10000, 0, 10000, 0.03, 1.0);
  const tordu = noteBoucle(10000, 0, 10000, 0.03, 5.0);
  assert.ok(compareNote(droit, tordu) < 0);
});

test("virages serres : nuls en ligne droite, eleves en zigzag", () => {
  const droite = [];
  for (let i = 0; i < 20; i++) droite.push([8000 + i, 48, 2 + i * 0.002]);
  const gD = grapheDe([voieSimple(8100, droite)]);
  const cD = contracte(gD.brut, gD.nbNoeuds, new Set());
  const trajetD = [[0, cD.aretes[0].u]];
  assert.equal(viragesSerres(trajetD, cD.aretes, gD.lat, gD.lon,
                             cD.aretes[0].longueur), 0);

  // Aller-retour en accordeon : des demi-tours a chaque pas.
  const zigzag = [];
  for (let i = 0; i < 20; i++) {
    zigzag.push([8200 + i, 48 + (i % 2) * 0.0008, 2 + (i % 2 ? -0.0004 : 0.0016)]);
  }
  const gZ = grapheDe([voieSimple(8300, zigzag)]);
  const cZ = contracte(gZ.brut, gZ.nbNoeuds, new Set());
  const trajetZ = [[0, cZ.aretes[0].u]];
  assert.ok(viragesSerres(trajetZ, cZ.aretes, gZ.lat, gZ.lon,
                          cZ.aretes[0].longueur) > 0);
});

test("polyligne : le sens de parcours est respecte", () => {
  const points = [[9100, 48, 2], [9101, 48, 2.001], [9102, 48, 2.002]];
  const G1 = grapheDe([voieSimple(9200, points)]);
  const { aretes } = contracte(G1.brut, G1.nbNoeuds, new Set());
  const a = aretes[0];
  const endroit = polyligneDuTrajet([[0, a.u]], aretes);
  const envers = polyligneDuTrajet([[0, a.v]], aretes);
  assert.deepEqual(endroit, [...envers].reverse());
  assert.equal(endroit.length, 3);
});

// --- sortie ---------------------------------------------------------------
test("allegement : parite avec Python", () => {
  for (const c of lecture("allege.json")) {
    const points = [];
    for (let i = 0; i < c.taille; i++) points.push([45.0 + i * 1e-4, 1.0 + i * 1e-4]);
    const obtenu = allege(points, c.maximum);
    assert.equal(obtenu.length, c.resultat.length, `taille ${c.taille}`);
    for (let i = 0; i < obtenu.length; i++) {
      assert.ok(Math.abs(obtenu[i][0] - c.resultat[i][0]) < 1e-12);
      assert.ok(Math.abs(obtenu[i][1] - c.resultat[i][1]) < 1e-12);
    }
  }
});

test("allegement : le dernier point est toujours conserve", () => {
  const points = [];
  for (let i = 0; i < 1000; i++) points.push([45 + i * 1e-4, 1]);
  const reduit = allege(points, 100);
  assert.ok(reduit.length <= 101);
  assert.deepEqual(reduit[reduit.length - 1], points[999]);
  assert.deepEqual(reduit[0], points[0]);
});

test("GPX : structure valide et attribution ODbL embarquee", () => {
  const points = [[48.123456789, 2.9], [48.2, 2.8], [48.3, 2.7]];
  const gpx = ecritGPX(points, "Boucle 7.0 km");

  assert.ok(gpx.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(gpx.includes('<gpx version="1.1"'));
  assert.ok(gpx.includes("http://www.topografix.com/GPX/1/1"));
  assert.ok(gpx.includes("<name>Boucle 7.0 km</name>"));
  // Attribution : elle doit voyager avec le fichier.
  assert.ok(gpx.includes('<copyright author="OpenStreetMap contributors">'));
  assert.ok(gpx.includes("opendatacommons.org/licenses/odbl/"));
  // Un point par trkpt, coordonnees a six decimales.
  const trkpts = gpx.match(/<trkpt /g) || [];
  assert.equal(trkpts.length, 3);
  assert.ok(gpx.includes('lat="48.123457"'), "arrondi a six decimales");
  // Balises equilibrees.
  for (const balise of ["metadata", "trk", "trkseg", "gpx", "copyright"]) {
    assert.equal((gpx.match(new RegExp(`<${balise}[ >]`, "g")) || []).length,
                 (gpx.match(new RegExp(`</${balise}>`, "g")) || []).length,
                 `balise ${balise} desequilibree`);
  }
  // Un nom hostile ne casse pas le XML.
  const hostile = ecritGPX(points, 'Boucle <script> & "guillemets"');
  assert.ok(!hostile.includes("<script>"));
  assert.ok(hostile.includes("&amp;"));
});

test("GeoJSON : ordre longitude-latitude et attribution", () => {
  const contenu = JSON.parse(ecritGeoJSON([[48.5, 2.5], [48.6, 2.6]]));
  assert.equal(contenu.geometry.type, "LineString");
  assert.deepEqual(contenu.geometry.coordinates[0], [2.5, 48.5]);
  assert.ok(contenu.properties.attribution.includes("OpenStreetMap"));
});

test("nommage : horodate, unique et classable", () => {
  const date = new Date(2026, 8, 9, 18, 45);
  assert.equal(nomHorodate(7, date), "2026-09-09_18h45_7.0km.gpx");
  assert.equal(nomHorodate(21.1, date), "2026-09-09_18h45_21.1km.gpx");
  assert.equal(nomTrace(7, true, date), "Boucle 7.0 km du 09/09/2026");
  assert.equal(nomTrace(7, false, date), "Parcours 7.0 km du 09/09/2026");
});
