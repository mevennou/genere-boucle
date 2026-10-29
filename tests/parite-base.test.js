// Parite avec le script Python d'origine : geometrie et regles de
// praticabilite. Les fixtures sont produites par tests/parite.py en executant
// le vrai code Python, pas une reimplementation.
import test from "node:test";
import assert from "node:assert/strict";
import { lecture } from "./utils.js";

import {
  distanceHaversine, capEntre, pointADistance, boiteEnglobante, arrondiPython,
} from "../docs/js/geo.js";
import { evalueVoie, nombre } from "../docs/js/regles.js";

test("geometrie : parite exacte avec Python sur 2000 tirages", () => {
  const cas = lecture("geometrie.json");
  let pireHaversine = 0, pireCap = 0, pirePoint = 0;

  for (const c of cas) {
    const [lat1, lon1, lat2, lon2, cap, distance] = c.entree;

    const h = distanceHaversine(lat1, lon1, lat2, lon2);
    pireHaversine = Math.max(pireHaversine, Math.abs(h - c.haversine));

    const k = capEntre(lat1, lon1, lat2, lon2);
    // Ecart circulaire : 359.9999 et 0.0001 sont voisins, pas opposes.
    const dc = Math.abs(((k - c.cap + 540) % 360) - 180);
    pireCap = Math.max(pireCap, dc);

    const [pl, po] = pointADistance(lat1, lon1, cap, distance);
    pirePoint = Math.max(pirePoint,
      Math.abs(pl - c.point[0]),
      Math.abs(((po - c.point[1] + 540) % 360) - 180));

    assert.equal(boiteEnglobante(lat1, lon1, distance), c.boite);
  }

  // Tolerance au flottant uniquement : ces ecarts viennent de l'ordre des
  // operations, pas d'une formule differente.
  assert.ok(pireHaversine < 1e-6, `haversine ecart ${pireHaversine} m`);
  assert.ok(pireCap < 1e-9, `cap ecart ${pireCap} deg`);
  assert.ok(pirePoint < 1e-11, `point ecart ${pirePoint} deg`);
});

test("geometrie : reperes connus", () => {
  // Un degre de latitude a l'equateur.
  assert.ok(Math.abs(distanceHaversine(0, 0, 1, 0) - 111195) < 10);
  // Cardinaux.
  assert.ok(Math.abs(capEntre(0, 0, 1, 0) - 0) < 1e-9);
  assert.ok(Math.abs(capEntre(0, 0, 0, 1) - 90) < 1e-9);
  assert.ok(Math.abs(capEntre(1, 0, 0, 0) - 180) < 1e-9);
  assert.ok(Math.abs(capEntre(0, 1, 0, 0) - 270) < 1e-9);
  // Aller-retour : partir a 1000 m puis mesurer redonne 1000 m.
  const [la, lo] = pointADistance(48.85, 2.35, 137, 1000);
  assert.ok(Math.abs(distanceHaversine(48.85, 2.35, la, lo) - 1000) < 1e-6);
  // Passage de l'antimeridien : la longitude reste dans [-180, 180].
  const [, lonAnti] = pointADistance(0, 179.99, 90, 5000);
  assert.ok(lonAnti >= -180 && lonAnti <= 180);
  assert.ok(lonAnti < 0, "doit basculer du cote negatif");
});

test("arrondi : demis vers le pair, comme Python", () => {
  for (const c of lecture("arrondi.json")) {
    assert.equal(arrondiPython(c.valeur), c.resultat,
      `arrondiPython(${c.valeur})`);
  }
  // Explicitement : la ou Math.round se tromperait.
  assert.equal(arrondiPython(0.5), 0);
  assert.equal(arrondiPython(1.5), 2);
  assert.equal(arrondiPython(2.5), 2);
  assert.notEqual(arrondiPython(0.5), Math.round(0.5));
});

test("lecture de nombre : parite avec _nombre", () => {
  for (const c of lecture("nombre.json")) {
    assert.equal(nombre(c.valeur), c.resultat, `nombre(${JSON.stringify(c.valeur)})`);
  }
  // Le piege : parseFloat accepterait "1.5m", pas Python.
  assert.equal(nombre("1.5m"), null);
  assert.equal(nombre("1,5 m"), 1.5);
  assert.equal(nombre("abc"), null);
  assert.equal(nombre(undefined), null);
});

test("praticabilite : parite exacte sur toutes les combinaisons de tags", () => {
  const cas = lecture("evalue_voie.json");
  let refus = 0, acceptations = 0, pireCout = 0;

  for (const c of cas) {
    const obtenu = evalueVoie(c.tags, c.niveau, c.balise);
    const attendu = c.verdict;
    const contexte = `${JSON.stringify(c.tags)} niveau=${c.niveau} balise=${c.balise}`;

    if (attendu === null) {
      assert.equal(obtenu, null, `devait etre refusee : ${contexte}`);
      refus++;
      continue;
    }
    assert.notEqual(obtenu, null, `devait etre acceptee : ${contexte}`);
    acceptations++;
    pireCout = Math.max(pireCout, Math.abs(obtenu[0] - attendu[0]));
    assert.equal(obtenu[1], attendu[1], `etiquette : ${contexte}`);
    assert.equal(obtenu[2], attendu[2], `qualite : ${contexte}`);
  }

  assert.ok(pireCout < 1e-12, `cout ecart ${pireCout}`);
  // Garde-fou : un test qui n'exercerait qu'une branche ne prouve rien.
  assert.ok(refus > 1000, `trop peu de refus couverts (${refus})`);
  assert.ok(acceptations > 1000, `trop peu d'acceptations couvertes (${acceptations})`);
  console.log(`      ${cas.length} verdicts compares `
            + `(${refus} refus, ${acceptations} acceptations)`);
});

test("praticabilite : les refus qui comptent vraiment", () => {
  const n = "normal";
  // Voies rapides : jamais, quel que soit le niveau.
  for (const hw of ["motorway", "trunk", "primary", "construction"]) {
    for (const niveau of ["strict", "normal", "tolerant"]) {
      assert.equal(evalueVoie({ highway: hw }, niveau), null, `${hw}/${niveau}`);
    }
  }
  // Interdictions d'acces.
  assert.equal(evalueVoie({ highway: "footway", foot: "no" }, n), null);
  assert.equal(evalueVoie({ highway: "footway", access: "private" }, n), null);
  // foot=yes prime sur access=private.
  assert.notEqual(evalueVoie({ highway: "footway", access: "private", foot: "yes" }, n), null);
  // Desserte privee : refusee sauf en tolerant.
  assert.equal(evalueVoie({ highway: "service", service: "driveway" }, n), null);
  assert.notEqual(evalueVoie({ highway: "service", service: "driveway" }, "tolerant"), null);
  // Etat du terrain.
  assert.equal(evalueVoie({ highway: "path", ford: "yes", surface: "asphalt" }, n), null);
  assert.equal(evalueVoie({ highway: "path", overgrown: "yes", surface: "asphalt" }, n), null);
  assert.equal(evalueVoie({ highway: "path", informal: "yes", surface: "asphalt" }, n), null);
  assert.equal(evalueVoie({ highway: "path", surface: "asphalt", width: "0.4" }, n), null);
  // Sentier sans revetement ni preuve d'entretien : refuse en normal,
  // accepte des qu'il porte un nom.
  assert.equal(evalueVoie({ highway: "path" }, n), null);
  assert.notEqual(evalueVoie({ highway: "path", name: "Sentier du bois" }, n), null);
  assert.notEqual(evalueVoie({ highway: "path" }, n, true), null);
  assert.notEqual(evalueVoie({ highway: "path" }, "tolerant"), null);
  // Strict : revetement dur obligatoire sur les voies naturelles.
  assert.equal(evalueVoie({ highway: "path", name: "x", surface: "ground" }, "strict"), null);
  assert.notEqual(evalueVoie({ highway: "path", surface: "asphalt" }, "strict"), null);
});

test("praticabilite : pas de route de campagne sans trottoir", () => {
  // Le defaut signale : le site faisait courir sur des routes a 80 km/h sans
  // trottoir, parce qu'une route y coutait moins cher qu'un sentier nomme.
  const campagne = [
    { highway: "unclassified", maxspeed: "80" },
    { highway: "tertiary", maxspeed: "70" },
    { highway: "secondary", maxspeed: "90", sidewalk: "no" },
    // Limite implicite, sans chiffre : c'est ainsi qu'est notee une bonne
    // part des routes francaises.
    { highway: "unclassified", maxspeed: "FR:rural" },
    { highway: "tertiary", "source:maxspeed": "FR:rural" },
    { highway: "road", maxspeed: "50 mph" },
  ];
  for (const tags of campagne) {
    for (const niveau of ["strict", "normal"]) {
      assert.equal(evalueVoie(tags, niveau), null, `${JSON.stringify(tags)} ${niveau}`);
    }
    // Le niveau tolerant la garde, mais bien plus chere qu'une rue.
    const verdict = evalueVoie(tags, "tolerant");
    assert.notEqual(verdict, null, JSON.stringify(tags));
    assert.ok(verdict[0] > 3 * evalueVoie({ highway: "residential" }, "tolerant")[0],
      `${JSON.stringify(tags)} trop peu rencherie : ${verdict[0]}`);
  }

  // Un trottoir, d'un cote ou cartographie a part, rend la route praticable.
  const bordees = [
    { highway: "unclassified", maxspeed: "80", sidewalk: "left" },
    { highway: "tertiary", maxspeed: "80", "sidewalk:both": "separate" },
    { highway: "tertiary", maxspeed: "80", "sidewalk:right": "yes" },
    { highway: "secondary", maxspeed: "80", foot: "designated" },
  ];
  for (const tags of bordees) {
    assert.notEqual(evalueVoie(tags, "normal"), null, JSON.stringify(tags));
  }

  // En ville, la meme route sans trottoir reste un passage possible.
  for (const tags of [{ highway: "tertiary", maxspeed: "50" },
                      { highway: "unclassified", "zone:maxspeed": "FR:30" },
                      { highway: "tertiary", "maxspeed:type": "FR:urban" }]) {
    assert.notEqual(evalueVoie(tags, "normal"), null, JSON.stringify(tags));
  }

  // Sans limite connue, on ne suppose pas le pire : ce sont surtout des
  // chemins entre hameaux et des rues de bourg non renseignes.
  assert.notEqual(evalueVoie({ highway: "unclassified" }, "normal"), null);
  // Une rue residentielle n'est jamais une route de campagne.
  assert.notEqual(evalueVoie({ highway: "residential" }, "normal"), null);
});

test("praticabilite : les couts vont dans le bon sens", () => {
  const cout = (tags, niveau = "normal", balise = false) =>
    evalueVoie(tags, niveau, balise)[0];
  // Un trottoir coute moins cher qu'une departementale.
  assert.ok(cout({ highway: "footway" }) < cout({ highway: "secondary" }));
  // Un itineraire balise est favorise.
  assert.ok(cout({ highway: "path", surface: "asphalt" }, "normal", true)
          < cout({ highway: "path", surface: "asphalt" }, "normal", false));
  // Une departementale sans trottoir coute plus cher.
  assert.ok(cout({ highway: "secondary", sidewalk: "no" })
          > cout({ highway: "secondary", sidewalk: "both" }));
  // Une voie rapide limitee a 90 coute encore plus cher, meme bordee d'un
  // trottoir. Sans trottoir, elle n'entre pas du tout : voir plus bas.
  assert.ok(cout({ highway: "secondary", maxspeed: "90", sidewalk: "both" })
          > cout({ highway: "secondary", maxspeed: "30", sidewalk: "both" }));
  // Une route dont on ignore la limite coute plus cher qu'une route bordee
  // d'un trottoir : le premier chemin parallele doit l'emporter.
  assert.ok(cout({ highway: "unclassified" })
          > cout({ highway: "unclassified", sidewalk: "both" }));
  // Les qualites annoncees sont les bonnes.
  assert.equal(evalueVoie({ highway: "residential" }, "normal")[2], "voirie");
  assert.equal(evalueVoie({ highway: "footway", surface: "asphalt" }, "normal")[2], "dure");
  assert.equal(evalueVoie({ highway: "path", surface: "ground", name: "x" }, "normal")[2], "meuble");
  assert.equal(evalueVoie({ highway: "footway" }, "normal", true)[2], "balise");
});
