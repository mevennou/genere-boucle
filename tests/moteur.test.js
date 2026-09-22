// Bout en bout : l'algorithme complet sur un reseau fabrique, compare aux
// sorties du script Python d'origine obtenues sur exactement le meme reseau.
import test from "node:test";
import assert from "node:assert/strict";
import { lecture } from "./utils.js";
import { genere, BoucleIntrouvable, choisitSansDoublement, MARGE_REPLI }
  from "../docs/js/moteur.js";
import { reseauCouloir } from "./reseaux.js";
import { distanceHaversine } from "../docs/js/geo.js";
import { ecritGPX } from "../docs/js/sortie.js";

const { voies, noeuds_interdits: noeudsInterdits } = lecture("reseau.json");

// Source de donnees injectee : aucun acces reseau dans les tests.
const sourceLocale = (v = voies) => ({
  reseau: async () => v,
  itineraires: async () => new Set(),
  barrieres: async () => [],
});

// Coordonnees des noeuds que le trace ne doit jamais emprunter : ils
// n'appartiennent qu'a des voies rapides, interdites aux pietons ou informelles.
const interdites = [];
for (const voie of voies) {
  voie.nodes.forEach((id, k) => {
    if (noeudsInterdits.includes(id)) interdites.push(voie.geometry[k]);
  });
}

const DEPART = [47.0096, 5.0096];

function longueurReelle(points) {
  let total = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    total += distanceHaversine(points[i][0], points[i][1],
                              points[i + 1][0], points[i + 1][1]);
  }
  return total;
}

test("bout en bout : memes distances que le Python d'origine", async () => {
  const attendus = lecture("bout_en_bout.json");
  for (const cas of attendus) {
    const r = await genere({
      lat: DEPART[0], lon: DEPART[1], cibleM: cas.km * 1000,
      niveau: cas.niveau, caps: 8, sommets: [3, 4], iterations: 8,
      source: sourceLocale(),
    });
    assert.ok(cas.ok, `Python avait echoue sur ${cas.km} km`);
    // Meme reseau, meme algorithme : la distance doit coller au metre pres.
    assert.ok(Math.abs(r.distance - cas.distance) < 1.0,
      `${cas.km} km / ${cas.niveau} : ${r.distance.toFixed(1)} m contre `
      + `${cas.distance.toFixed(1)} m en Python`);
    assert.ok(Math.abs(r.repetee - cas.repetee) < 1.0, "repetition differente");
    assert.equal(r.points.length, cas.nb_points, "nombre de points different");
    for (const bout of ["premier", "dernier"]) {
      const point = bout === "premier" ? r.points[0] : r.points[r.points.length - 1];
      assert.ok(Math.abs(point[0] - cas[bout][0]) < 1e-9
             && Math.abs(point[1] - cas[bout][1]) < 1e-9, `${bout} point`);
    }
  }
});

test("bout en bout : la boucle se referme sur son depart", async () => {
  for (const km of [3, 5, 8]) {
    const r = await genere({
      lat: DEPART[0], lon: DEPART[1], cibleM: km * 1000,
      caps: 8, sommets: [3, 4], iterations: 8, source: sourceLocale(),
    });
    const premier = r.points[0], dernier = r.points[r.points.length - 1];
    assert.ok(distanceHaversine(premier[0], premier[1], dernier[0], dernier[1]) < 1,
      `${km} km : la boucle ne se referme pas`);
    assert.equal(r.boucle, true);
  }
});

test("bout en bout : la distance obtenue tient la cible", async () => {
  for (const km of [3, 5, 8]) {
    const cible = km * 1000;
    const r = await genere({
      lat: DEPART[0], lon: DEPART[1], cibleM: cible,
      caps: 8, sommets: [3, 4], iterations: 8, source: sourceLocale(),
    });
    const ecart = Math.abs(r.distance - cible) / cible;
    assert.ok(ecart < 0.05, `${km} km : ecart de ${(ecart * 100).toFixed(1)} %`);
    // La distance annoncee doit correspondre au trace reellement dessine.
    const mesuree = longueurReelle(r.points);
    assert.ok(Math.abs(mesuree - r.distance) / r.distance < 0.01,
      `annonce ${r.distance.toFixed(0)} m, dessine ${mesuree.toFixed(0)} m`);
  }
});

test("bout en bout : aucun aller-retour au-dela du seuil", async () => {
  for (const km of [3, 5, 8]) {
    const r = await genere({
      lat: DEPART[0], lon: DEPART[1], cibleM: km * 1000,
      caps: 8, sommets: [3, 4], iterations: 8, repetitionMax: 0.12,
      source: sourceLocale(),
    });
    assert.ok(r.partRepetee <= 0.12,
      `${km} km : ${(r.partRepetee * 100).toFixed(0)} % de repetition`);
  }
});

test("bout en bout : le trace n'emprunte jamais une voie refusee", async () => {
  // Garantie structurelle : ces noeuds ne sont sur aucune voie praticable,
  // ils ne peuvent donc pas figurer dans le graphe, donc pas dans le trace.
  assert.ok(interdites.length >= 5, "le reseau de test doit contenir des pieges");
  for (const km of [3, 5, 8]) {
    const r = await genere({
      lat: DEPART[0], lon: DEPART[1], cibleM: km * 1000,
      caps: 8, sommets: [3, 4], iterations: 8, source: sourceLocale(),
    });
    for (const point of r.points) {
      for (const piege of interdites) {
        assert.ok(distanceHaversine(point[0], point[1], piege.lat, piege.lon) > 1,
          `${km} km : le trace passe par une voie refusee`);
      }
    }
  }
});

test("bout en bout : tous les points du trace sont des points du reseau", async () => {
  const connus = new Set();
  for (const voie of voies) {
    for (const p of voie.geometry) connus.add(`${p.lat.toFixed(7)},${p.lon.toFixed(7)}`);
  }
  const r = await genere({
    lat: DEPART[0], lon: DEPART[1], cibleM: 5000,
    caps: 8, sommets: [3, 4], iterations: 8, source: sourceLocale(),
  });
  for (const [lat, lon] of r.points) {
    assert.ok(connus.has(`${lat.toFixed(7)},${lon.toFixed(7)}`),
      `point inconnu du reseau : ${lat}, ${lon}`);
  }
});

test("bout en bout : le GPX produit est complet et exploitable", async () => {
  const r = await genere({
    lat: DEPART[0], lon: DEPART[1], cibleM: 5000,
    caps: 8, sommets: [3, 4], iterations: 8, source: sourceLocale(),
  });
  const gpx = ecritGPX(r.points, "Boucle 5.0 km");
  const trkpts = [...gpx.matchAll(/<trkpt lat="([-\d.]+)" lon="([-\d.]+)"/g)];
  assert.equal(trkpts.length, r.points.length);
  // Relire le GPX doit redonner la meme distance.
  const relus = trkpts.map((m) => [parseFloat(m[1]), parseFloat(m[2])]);
  assert.ok(Math.abs(longueurReelle(relus) - r.distance) / r.distance < 0.01);
  assert.ok(gpx.includes("opendatacommons.org/licenses/odbl/"));
});

test("bout en bout : les statistiques annoncees sont coherentes", async () => {
  const r = await genere({
    lat: DEPART[0], lon: DEPART[1], cibleM: 5000,
    caps: 8, sommets: [3, 4], iterations: 8, source: sourceLocale(),
  });
  const sommeTypes = r.types.reduce((s, [, m]) => s + m, 0);
  const sommeQualites = r.qualites.reduce((s, [, m]) => s + m, 0);
  assert.ok(Math.abs(sommeTypes - r.longueurBoucle) < 1, "types incomplets");
  assert.ok(Math.abs(sommeQualites - r.longueurBoucle) < 1, "qualites incompletes");
  // Triees par metrage decroissant.
  for (let i = 1; i < r.types.length; i++) {
    assert.ok(r.types[i - 1][1] >= r.types[i][1]);
  }
  assert.ok(r.accroche < 200, "le depart doit s'accrocher pres du point demande");
});

test("echecs : messages utiles plutot que plantages", async () => {
  // Reseau vide.
  await assert.rejects(
    genere({ lat: 47.0096, lon: 5.0096, cibleM: 5000, source: sourceLocale([]) }),
    (e) => e instanceof BoucleIntrouvable && /Trop peu de voies/.test(e.message));

  // Depart au milieu de nulle part, loin de tout chemin.
  await assert.rejects(
    genere({ lat: 10.0, lon: 10.0, cibleM: 5000, source: sourceLocale() }),
    (e) => e instanceof BoucleIntrouvable);

  // Niveau strict sur un reseau qui n'a que des sentiers non documentes.
  const sentiers = voies.map((v) => ({ ...v, tags: { highway: "path" } }));
  await assert.rejects(
    genere({ lat: 47.0096, lon: 5.0096, cibleM: 5000, niveau: "strict",
             source: sourceLocale(sentiers) }),
    (e) => e instanceof BoucleIntrouvable);
});

test("resilience : les donnees annexes peuvent manquer sans tout casser", async () => {
  // Itineraires balises et barrieres indisponibles : la generation continue,
  // avec un filtrage plus severe et jamais moins sur.
  const boiteuse = {
    reseau: async () => voies,
    itineraires: async () => { throw new Error("service indisponible"); },
    barrieres: async () => { throw new Error("service indisponible"); },
  };
  const lignes = [];
  const r = await genere({
    lat: DEPART[0], lon: DEPART[1], cibleM: 5000, caps: 8, sommets: [3, 4],
    iterations: 8, source: boiteuse, journal: (l) => lignes.push(l),
  });
  assert.ok(r.points.length > 10);
  assert.ok(lignes.some((l) => /balises indisponibles/.test(l)),
    "l'utilisateur doit etre prevenu du filtrage plus severe");
});

test("performance : une generation reste sous la seconde sur ce reseau", async () => {
  const debut = performance.now();
  await genere({
    lat: DEPART[0], lon: DEPART[1], cibleM: 8000,
    caps: 16, sommets: [3, 4, 5, 6], iterations: 10, source: sourceLocale(),
  });
  const duree = performance.now() - debut;
  console.log(`      generation complete en ${duree.toFixed(0)} ms `
            + "(16 orientations x 4 formes x 10 iterations)");
  assert.ok(duree < 5000, `trop lent : ${duree.toFixed(0)} ms`);
});

// --- depart et arrivee differents ----------------------------------------
// Ce mode n'etait couvert par aucun test : une variable manquante y est passee
// inapercue jusqu'en production. Il est desormais exerce comme le reste.
test("parcours A vers B : genere un trace entre deux points distincts", async () => {
  const arrivee = [47.0096 + 0.004, 5.0096 + 0.004];
  for (const km of [2, 3]) {
    const r = await genere({
      lat: DEPART[0], lon: DEPART[1], cibleM: km * 1000, arrivee,
      iterations: 8, source: sourceLocale(),
    });
    assert.equal(r.boucle, false);
    const premier = r.points[0], dernier = r.points[r.points.length - 1];
    assert.ok(distanceHaversine(premier[0], premier[1], DEPART[0], DEPART[1]) < 200,
      "le trace doit partir du point demande");
    assert.ok(distanceHaversine(dernier[0], dernier[1], arrivee[0], arrivee[1]) < 200,
      "le trace doit finir a l'arrivee demandee");
    assert.ok(distanceHaversine(premier[0], premier[1], dernier[0], dernier[1]) > 300,
      "ce n'est pas une boucle");
    const ecart = Math.abs(r.distance - km * 1000) / (km * 1000);
    assert.ok(ecart < 0.08, `${km} km : ecart de ${(ecart * 100).toFixed(1)} %`);
  }
});

test("parcours A vers B : un reseau trop petit rend le possible, sans mentir", async () => {
  // Le damier de test sature vers 3,5 km. Demander davantage ne doit ni
  // planter, ni fabriquer de la distance en doublant des portions : le moteur
  // rend le meilleur parcours et l'ecart reste lisible dans le resultat.
  const r = await genere({
    lat: DEPART[0], lon: DEPART[1], cibleM: 5000,
    arrivee: [47.0096 + 0.004, 5.0096 + 0.004], iterations: 8, source: sourceLocale(),
  });
  assert.ok(r.distance < 5000, "le reseau ne permet pas la distance demandee");
  assert.equal(r.cible, 5000, "la cible demandee reste exposee pour l'affichage");
  assert.ok(r.doublement <= 30,
    "manquer la distance est acceptable, doubler une portion ne l'est pas");
});

test("parcours A vers B : le controle anti-doublement s'applique aussi", async () => {
  const r = await genere({
    lat: DEPART[0], lon: DEPART[1], cibleM: 5000,
    arrivee: [47.0096 + 0.004, 5.0096 + 0.004], iterations: 8, source: sourceLocale(),
  });
  assert.equal(typeof r.doublement, "number", "la mesure doit remonter");
  assert.ok(r.doublement <= Math.max(30, 5000 * 0.005),
    `${r.doublement.toFixed(0)} m doubles sur le parcours`);
  const sommeTypes = r.types.reduce((s, [, m]) => s + m, 0);
  assert.ok(Math.abs(sommeTypes - r.longueurBoucle) < 1, "statistiques incoherentes");
});

// Traces fabriques pour le controle geometrique : l'un file tout droit,
// l'autre revient sur ses pas cinq metres a cote.
const DLAT = (m) => m / 111320;
const DLON = (m) => m / 111320 / Math.cos(47 * Math.PI / 180);

function ligneDroite(longueur, pas = 20) {
  const points = [];
  for (let d = 0; d <= longueur; d += pas) points.push([47, 5 + DLON(d)]);
  return points;
}

function allerRetour(longueur, pas = 20) {
  const moitie = longueur / 2;
  const points = [];
  for (let d = 0; d <= moitie; d += pas) points.push([47, 5 + DLON(d)]);
  for (let d = moitie; d >= 0; d -= pas) points.push([47 + DLAT(5), 5 + DLON(d)]);
  return points;
}

test("parcours A vers B : le repli anti-doublement ne brade pas la distance", () => {
  // Defaut constate en production : 15 km demandes entre deux points, 1,07 km
  // rendu. Le meilleur candidat longeait une portion de lui-meme, alors le
  // repli a parcouru la reserve et a fini par retenir le plus court chemin
  // direct : il ne double rien, puisqu'il ne fait aucun detour.
  const traces = new Map();
  const candidat = (longueur, seLonge) => {
    const c = [[0, 0, 0], longueur, 0];
    traces.set(c, seLonge ? allerRetour(longueur) : ligneDroite(longueur));
    return c;
  };
  const pointsDe = (c) => traces.get(c);

  const surLaCible = candidat(10000, true);    // pile sur la cible, mais se longe
  const unPeuCourt = candidat(9400, false);    // 6 % trop court, et propre
  const direct = candidat(1000, false);        // le plus court chemin, propre

  // Le candidat legerement plus court est un repli raisonnable.
  const [choisi, mesure] = choisitSansDoublement(
    surLaCible, [surLaCible, unPeuCourt, direct], 10000, 50, pointsDe, 8);
  assert.equal(choisi, unPeuCourt,
    "le repli doit s'arreter au candidat qui tient encore la distance");
  assert.equal(mesure.longueur, 0);

  // Le chemin direct, lui, ne repond pas a la demande : mieux vaut garder le
  // meilleur et annoncer le doublement que de rendre dix fois trop court.
  const [garde, doublement] = choisitSansDoublement(
    surLaCible, [surLaCible, direct], 10000, 50, pointsDe, 8);
  assert.equal(garde, surLaCible,
    "un parcours dix fois trop court n'est pas un repli acceptable");
  assert.ok(doublement.longueur > 50,
    "le doublement restant doit etre mesure, donc annoncable");
});

test("le repli respecte sa marge quelle que soit la reserve", () => {
  // Balayage systematique plutot qu'un cas choisi : la regle doit tenir pour
  // n'importe quelle reserve, y compris celles ou tous les candidats longent
  // une portion d'eux-memes.
  let graine = 12345;
  const hasard = () => (graine = (graine * 1103515245 + 12345) % 2147483648) / 2147483648;

  for (let essai = 0; essai < 200; essai++) {
    const cible = 5000 + Math.floor(hasard() * 15000);
    const traces = new Map();
    const fabrique = (longueur, seLonge) => {
      const c = [[0, 0, 0], longueur, 0];
      traces.set(c, seLonge ? allerRetour(longueur) : ligneDroite(longueur));
      return c;
    };
    // Une reserve quelconque, du plus court au plus long, et un meilleur
    // candidat tire au sort parmi elle.
    const reserve = [];
    for (let k = 0; k < 8; k++) {
      reserve.push(fabrique(Math.max(400, Math.round(cible * (0.05 + hasard() * 1.4))),
                            hasard() < 0.6));
    }
    const meilleur = reserve[Math.floor(hasard() * reserve.length)];

    const [choisi] = choisitSansDoublement(meilleur, reserve, cible, 50,
                                           (c) => traces.get(c), 8);
    const erreur = (c) => Math.abs(c[1] - cible) / cible;
    assert.ok(choisi, "un candidat doit toujours etre retenu");
    assert.ok(erreur(choisi) <= erreur(meilleur) + MARGE_REPLI + 1e-9,
      `essai ${essai} : repli a ${(erreur(choisi) * 100).toFixed(0)} % alors que le `
      + `meilleur etait a ${(erreur(meilleur) * 100).toFixed(0)} % de la cible`);
  }
});

// --- le parcours rendu vaut-il les candidats trouves ? --------------------
//
// C'est l'invariant qui manquait, et qui a laisse passer un 15 km rendu en
// 1,07 km : le journal annonce la longueur de chaque candidat examine, donc on
// peut verifier que le parcours retenu n'est pas bien plus loin de la cible
// que le meilleur d'entre eux. Manquer la distance parce que le reseau ne la
// permet pas est legitime ; la manquer alors qu'un candidat l'atteignait ne
// l'est pas.

/** Meilleur ecart relatif a la cible parmi les candidats annonces au journal. */
function meilleurCandidatAnnonce(lignes, cibleM) {
  let meilleur = Infinity;
  for (const ligne of lignes) {
    // Boucles : "3s: 4.25km/0%" — point a point : "gauche : 4.25 km / 0 %".
    for (const m of ligne.matchAll(/(\d+\.\d+)\s*km\s*\//g)) {
      const ecart = Math.abs(parseFloat(m[1]) * 1000 - cibleM) / cibleM;
      if (ecart < meilleur) meilleur = ecart;
    }
  }
  return meilleur;
}

async function verifieInvariant(nom, parametres) {
  const lignes = [];
  const r = await genere({ iterations: 10, journal: (l) => lignes.push(l), ...parametres });
  const rendu = Math.abs(r.distance - r.cible) / r.cible;
  const disponible = meilleurCandidatAnnonce(lignes, r.cible);
  assert.ok(disponible < Infinity, `${nom} : aucun candidat lu dans le journal`);
  assert.ok(rendu <= disponible + MARGE_REPLI + 1e-9,
    `${nom} : parcours rendu a ${(rendu * 100).toFixed(0)} % de la cible alors `
    + `qu'un candidat etait a ${(disponible * 100).toFixed(0)} %`);
  return r;
}

test("le parcours rendu n'est jamais bien plus loin de la cible que le meilleur candidat", async () => {
  const arrivee = [47.0096 + 0.004, 5.0096 + 0.004];
  for (const km of [3, 4, 5, 6]) {
    await verifieInvariant(`reseau.json A->B ${km} km`, {
      lat: DEPART[0], lon: DEPART[1], arrivee, cibleM: km * 1000, source: sourceLocale(),
    });
    await verifieInvariant(`reseau.json boucle ${km} km`, {
      lat: DEPART[0], lon: DEPART[1], cibleM: km * 1000, source: sourceLocale(),
    });
  }
});

test("meme invariant sur un reseau a trottoirs, ou le repli se declenche", async () => {
  // Ces reseaux font systematiquement longer une portion au meilleur
  // candidat : c'est donc le chemin de repli qui est exerce ici, celui-la
  // meme qui retenait le plus court chemin direct.
  for (const longueurCouloir of [200, 300]) {
    const { voies, depart } = reseauCouloir(longueurCouloir);
    const source = sourceLocale(voies);
    const arrivee = [depart[1] + 0.003, depart[2] + 0.003];
    for (const km of [3, 4, 5, 6]) {
      await verifieInvariant(`couloir ${longueurCouloir} A->B ${km} km`, {
        lat: depart[1], lon: depart[2], arrivee, cibleM: km * 1000, source,
      });
    }
    await verifieInvariant(`couloir ${longueurCouloir} boucle 8 km`, {
      lat: depart[1], lon: depart[2], cibleM: 8000, source,
    });
  }
});

test("parcours A vers B de 4 km : le reseau le permet, le moteur doit le tenir", async () => {
  // Cas precis que l'ancien code ratait : un candidat tombait pile sur les
  // 4 km, mais il longeait une portion de lui-meme ; le repli descendait
  // alors jusqu'a un parcours 12 % trop court. Le seul test point a point
  // existant s'arretait a 3 km, d'ou le trou.
  const r = await genere({
    lat: DEPART[0], lon: DEPART[1], arrivee: [47.0096 + 0.004, 5.0096 + 0.004],
    cibleM: 4000, iterations: 10, source: sourceLocale(),
  });
  const ecart = Math.abs(r.distance - 4000) / 4000;
  assert.ok(ecart < 0.08,
    `4 km demandes, ${(r.distance / 1000).toFixed(2)} km rendus (${(ecart * 100).toFixed(0)} %)`);
});

test("parcours A vers B : distance impossible, message clair", async () => {
  // Plus court que le plus court chemin praticable : il faut le dire, pas
  // inventer un trace.
  await assert.rejects(
    genere({ lat: DEPART[0], lon: DEPART[1], cibleM: 200,
             arrivee: [47.0096 + 0.008, 5.0096 + 0.008], source: sourceLocale() }),
    (e) => /trop courte|plus court chemin/i.test(e.message));
});
