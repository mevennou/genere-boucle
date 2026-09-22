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

import { mesureDoublement, mesureBouclettes, distancePointSegment }
  from "../docs/js/controle.js";
import { detecteCorridors } from "../docs/js/corridors.js";
import { construitGrapheBrut, contracte, supprimeImpasses, construitCSR } from "../docs/js/graphe.js";
import { SURCOUT_COTE_DROIT } from "../docs/js/routage.js";
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

// --- petites boucles ------------------------------------------------------
test("bouclettes : un circuit propre n'en contient aucune", () => {
  assert.equal(mesureBouclettes(carrePropre()).nombre, 0);
  // La fermeture de la boucle principale est le but recherche, pas un defaut.
  const ferme = [...carrePropre()];
  ferme.push(ferme[0]);
  assert.equal(mesureBouclettes(ferme).nombre, 0);
  // Trace trop court : pas de plantage.
  assert.equal(mesureBouclettes([[47, 5], [47, 5.001]]).nombre, 0);
});

test("bouclettes : un crochet referme sur lui-meme est vu", () => {
  // Le defaut des captures : le trace quitte un carrefour, fait le tour d'un
  // pate de maisons de 150 m de cote et revient au meme carrefour.
  const carre = carrePropre();
  const trace = carre.slice(0, 15);
  const [baseLat, baseLon] = trace[trace.length - 1];
  for (let k = 1; k <= 5; k++) trace.push([baseLat - dlat(k * 30), baseLon]);
  for (let k = 1; k <= 5; k++) trace.push([baseLat - dlat(150), baseLon + dlon(k * 30)]);
  for (let k = 1; k <= 5; k++) trace.push([baseLat - dlat(150 - k * 30), baseLon + dlon(150)]);
  for (let k = 1; k <= 5; k++) trace.push([baseLat, baseLon + dlon(150 - k * 30)]);
  trace.push(...carre.slice(15));

  const m = mesureBouclettes(trace);
  assert.equal(m.nombre, 1, "le crochet doit etre repere une fois, pas deux");
  assert.ok(m.longueur > 500, `bouclette de ${m.longueur.toFixed(0)} m seulement`);
});

test("bouclettes : un demi-tour n'est pas une boucle", () => {
  // Revenir sur ses pas est un doublement, pas un lacet : les deux mesures ne
  // doivent pas se confondre, sinon on corrigerait le mauvais defaut.
  const carre = carrePropre();
  const trace = [...carre, ...carre.slice(0, 20)];
  assert.ok(mesureDoublement(trace).longueur > 300);
  assert.equal(mesureBouclettes(trace).nombre, 0);
});

test("controle geometrique : parite exacte avec le script Python", () => {
  // Le site et le script appliquent le meme controle. Sans ces references,
  // les deux implementations divergeraient sans que rien ne le signale.
  for (const cas of lecture("controle.json")) {
    const d = mesureDoublement(cas.points);
    const b = mesureBouclettes(cas.points);
    assert.ok(Math.abs(d.longueur - cas.doublement) < 1e-6,
      `${cas.nom} : doublement ${d.longueur} contre ${cas.doublement} en Python`);
    assert.equal(d.portions.length, cas.nb_portions, `${cas.nom} : portions`);
    assert.ok(Math.abs(b.longueur - cas.bouclettes) < 1e-6,
      `${cas.nom} : bouclettes ${b.longueur} contre ${cas.bouclettes} en Python`);
    assert.equal(b.nombre, cas.nb_bouclettes, `${cas.nom} : nombre de bouclettes`);
  }
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

// --- courir a gauche ------------------------------------------------------
/** Rue est-ouest, ses deux trottoirs cartographies a part, traversees aux bouts. */
function rueADeuxTrottoirs() {
  let idN = 1, idV = 1;
  const voies = [];
  const voie = (pts, tags) => voies.push({
    type: "way", id: idV++, tags, nodes: pts.map((p) => p[0]),
    geometry: pts.map((p) => ({ lat: p[1], lon: p[2] })),
  });
  const ligne = (ecart) => {
    const pts = [];
    for (let x = 0; x <= 600; x += 50) pts.push([idN++, 47 + dlat(ecart), 5 + dlon(x)]);
    return pts;
  };
  const rue = ligne(0), nord = ligne(8), sud = ligne(-8);
  const bitume = { surface: "asphalt" };
  voie(rue, { highway: "residential", ...bitume });
  voie(nord, { highway: "footway", footway: "sidewalk", ...bitume });
  voie(sud, { highway: "footway", footway: "sidewalk", ...bitume });
  for (const k of [0, rue.length - 1]) {
    voie([sud[k], rue[k]], { highway: "footway", ...bitume });
    voie([rue[k], nord[k]], { highway: "footway", ...bitume });
  }
  return { voies, rue };
}

test("courir a gauche : le sens de parcours decide du trottoir", () => {
  // Hors agglomeration, le pieton circule pres du bord gauche de la chaussee.
  // Le graphe ne peut designer un bord que la ou les deux cotes sont
  // cartographies a part : c'est le cas ici, et le choix doit s'inverser avec
  // le sens de la course.
  const { voies, rue } = rueADeuxTrottoirs();
  const G = construitGrapheBrut(voies, "normal", new Set(), new Set());
  const { aretes, adjacence } = contracte(G.brut, G.nbNoeuds, new Set());
  const { couloir, decalage, alignement } = detecteCorridors(aretes, G.lat, G.lon);
  const routeur = new Routeur(construitCSR(adjacence, G.nbNoeuds), aretes,
                              G.lat, G.lon, G.nbNoeuds, couloir, decalage, alignement);

  const parCoord = new Map();
  for (let n = 0; n < G.nbNoeuds; n++) {
    parCoord.set(`${G.lat[n].toFixed(7)},${G.lon[n].toFixed(7)}`, n);
  }
  const noeudDe = (p) => parCoord.get(`${p[1].toFixed(7)},${p[2].toFixed(7)}`);
  const ouest = noeudDe(rue[0]), est = noeudDe(rue[rue.length - 1]);

  // Metres parcourus au nord et au sud de l'axe de la rue.
  const cotes = (trajet) => {
    let nord = 0, sud = 0;
    for (const [index] of trajet) {
      const p = aretes[index].polyligne;
      const ecart = (G.lat[p[Math.floor(p.length / 2)]] - 47) * 111320;
      if (ecart > 2) nord += aretes[index].longueur;
      else if (ecart < -2) sud += aretes[index].longueur;
    }
    return { nord, sud };
  };

  routeur.nouvellesPenalites();
  const versEst = cotes(routeur.plusCourtChemin(ouest, est)[1]);
  assert.ok(versEst.nord > 500 && versEst.sud === 0,
    `vers l'est, la gauche est au nord : ${JSON.stringify(versEst)}`);

  routeur.nouvellesPenalites();
  const versOuest = cotes(routeur.plusCourtChemin(est, ouest)[1]);
  assert.ok(versOuest.sud > 500 && versOuest.nord === 0,
    `vers l'ouest, la gauche est au sud : ${JSON.stringify(versOuest)}`);
});

test("courir a gauche : une preference, pas une interdiction", () => {
  // Un surcout trop fort ferait traverser la rue pour quelques metres, ou
  // ecarterait des itineraires valables. Il doit rester modere, et ne jamais
  // s'appliquer la ou la voie est cartographiee par son seul axe.
  assert.ok(SURCOUT_COTE_DROIT > 1 && SURCOUT_COTE_DROIT < 2,
    `surcout de ${SURCOUT_COTE_DROIT} : hors de proportion`);

  const { G, aretes } = grapheDe(lecture("reseau.json").voies);
  const { decalage } = detecteCorridors(aretes, G.lat, G.lon);
  assert.ok(decalage.every((d) => d === 0),
    "sans voie jumelle, aucun cote ne doit etre designe");
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
