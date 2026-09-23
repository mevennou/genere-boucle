// Qualite du trace sur un vrai reseau OpenStreetMap.
//
// Les reseaux fabriques des autres tests sont des damiers : trop reguliers
// pour produire les defauts qui apparaissent en ville. Un balayage sur ces
// damiers ne trouvait aucune petite boucle, alors que le site en produisait
// des poignees sur le terrain — c'est precisement le trou qui a laisse passer
// le defaut. D'ou cette extraction reelle, figee dans le depot : environ
// 2,6 km autour du Technopole de Brest, avec ses sentiers cotiers, ses
// lotissements et ses trottoirs cartographies a part.
//
// La fixture ne contient que les tags que evalue_voie lit, et des coordonnees
// arrondies au millionieme : elle sert a mesurer la forme du trace, pas a
// rendre une carte.
import test from "node:test";
import assert from "node:assert/strict";
import { lecture } from "./utils.js";
import { genere, BoucleIntrouvable } from "../docs/js/moteur.js";
import { mesureBouclettes } from "../docs/js/controle.js";
import { distanceHaversine } from "../docs/js/geo.js";

const { voies } = lecture("brest.json");
const source = {
  reseau: async () => voies,
  itineraires: async () => new Set(),
  barrieres: async () => [],
};

// Departs repartis dans l'extraction, distances que le reseau peut servir.
const DEPARTS = [[48.3602, -4.5712], [48.3650, -4.5650], [48.3555, -4.5680]];
const DISTANCES = [3, 4, 5, 6];

// Ce qu'on accepte de laisser passer. Ces bornes disent ou en est le moteur,
// pas ou il devrait etre : mesure sur cette extraction, deux parcours sur
// douze gardent une boucle, la pire de 340 m. C'est un plancher a tenir, pas
// un objectif atteint — il reste des crochets visibles a l'ecran, et les
// abaisser demandera de reprendre la facon dont les ancres sont choisies.
const BOUCLE_MAXIMALE = 400;      // metres, pour un seul parcours
const PART_AVEC_BOUCLE = 0.25;    // part des parcours qui peuvent en garder

async function balaye(avecArrivee) {
  const resultats = [];
  for (const [lat, lon] of DEPARTS) {
    for (const km of DISTANCES) {
      const arrivee = avecArrivee ? [lat + 0.002, lon - 0.010] : null;
      try {
        const r = await genere({ lat, lon, arrivee, cibleM: km * 1000,
                                 niveau: "normal", source });
        resultats.push({ lat, lon, km, arrivee, r });
      } catch (erreur) {
        // Un depart au bord de l'extraction peut n'etre relie a rien : c'est
        // une limite de la fixture, pas un defaut du moteur.
        assert.ok(erreur instanceof BoucleIntrouvable,
          `erreur inattendue : ${erreur.message}`);
      }
    }
  }
  assert.ok(resultats.length >= 8,
    `seulement ${resultats.length} parcours generes : la fixture ne sert a rien`);
  return resultats;
}

function verifie(resultats, quoi) {
  const avec = resultats.filter(({ r }) => r.nbBouclettes > 0);
  for (const { km, r } of avec) {
    assert.ok(r.bouclettes <= BOUCLE_MAXIMALE,
      `${quoi} ${km} km : ${r.nbBouclettes} petites boucles totalisant `
      + `${r.bouclettes.toFixed(0)} m — c'est un circuit qui est demande`);
  }
  assert.ok(avec.length <= Math.ceil(resultats.length * PART_AVEC_BOUCLE),
    `${quoi} : ${avec.length} parcours sur ${resultats.length} gardent une `
    + "petite boucle");
}

test("reseau reel : les boucles ne gardent pas de petites boucles", async () => {
  verifie(await balaye(false), "boucle");
});

test("reseau reel : les parcours d'un point a un autre non plus", async () => {
  verifie(await balaye(true), "parcours");
});

test("reseau reel : la mesure rendue decrit bien le trace rendu", async () => {
  // Le resultat annonce ses defauts : si l'annonce et le dessin divergeaient,
  // toutes les bornes ci-dessus ne verifieraient rien.
  for (const { r } of (await balaye(false)).slice(0, 4)) {
    const mesure = mesureBouclettes(r.points);
    assert.equal(r.nbBouclettes, mesure.nombre, "nombre de boucles annonce");
    assert.ok(Math.abs(r.bouclettes - mesure.longueur) < 1e-6, "longueur annoncee");
  }
});

// --- accrochage du depart et de l'arrivee ---------------------------------
//
// Une adresse cherchee ou une geolocalisation ne tombe pas sur une rue : elle
// tombe au milieu d'un site, d'un campus, d'un lotissement. Le noeud le plus
// proche a vol d'oiseau y appartient souvent a un ilot de quelques allees,
// sans lien avec le reste du reseau.
//
// Deux situations, deux reponses. Quand le reseau passe a quelques metres,
// c'est un trou de cartographie : on corrige sans ceremonie, comme on accroche
// deja tout point au noeud le plus proche. Quand il passe a deux cents metres,
// ce n'est plus une correction : rendre un parcours qui commence la-bas
// reviendrait a repondre a une autre question. Il faut le dire.
//
// Les deux points ci-dessous sont ceux qui ont fait echouer le site. Ils ne
// sont pas inventes.
const POSE_PROCHE = { lat: 48.361148, lon: -4.572282 };   // reseau a 29 m
const POSE_COUPEE = { lat: 48.357823, lon: -4.570741 };   // reseau a 175 m

test("reseau reel : un depart pose a cote du reseau y est raccroche", async () => {
  for (const km of [4, 5]) {
    const r = await genere({ ...POSE_PROCHE, cibleM: km * 1000,
                             niveau: "normal", source });
    assert.ok(r.distance > km * 1000 * 0.7,
      `${km} km : ${(r.distance / 1000).toFixed(2)} km rendus`);

    // Le trace part de la ou le moteur dit qu'il part, et la correction reste
    // de l'ordre de l'accrochage ordinaire.
    const depart = r.points[0];
    const ecart = distanceHaversine(POSE_PROCHE.lat, POSE_PROCHE.lon,
                                    depart[0], depart[1]);
    assert.ok(ecart <= 50, `depart deplace de ${ecart.toFixed(0)} m`);
    assert.ok(Math.abs(ecart - r.accroche) < 1,
      `ecart annonce ${r.accroche.toFixed(0)} m, reel ${ecart.toFixed(0)} m`);
  }
});

test("reseau reel : un depart coupe du reseau est deplace, et le dit", async () => {
  // Le defaut a corriger : le moteur rendait un parcours commencant a 175 m du
  // marqueur, qui lui restait sur place. La carte laissait donc croire que le
  // parcours partait d'un endroit d'ou il ne partait pas.
  const r = await genere({ ...POSE_COUPEE, cibleM: 5000, niveau: "normal", source });

  assert.ok(r.deplaceDepart > 100,
    `deplacement annonce : ${r.deplaceDepart.toFixed(0)} m`);
  // Ce que le resultat annonce est bien ce qu'il fait.
  const reel = distanceHaversine(POSE_COUPEE.lat, POSE_COUPEE.lon,
                                 r.points[0][0], r.points[0][1]);
  assert.ok(Math.abs(reel - r.deplaceDepart) < 1,
    `annonce ${r.deplaceDepart.toFixed(0)} m, reel ${reel.toFixed(0)} m`);
  assert.ok(Math.abs(reel - r.accroche) < 1, "l'accroche dit la meme chose");
  // Et un parcours utilisable en sort.
  assert.ok(r.distance > 3500, `${(r.distance / 1000).toFixed(2)} km rendus`);
});

test("reseau reel : un depart pose sur une rue n'est jamais deplace", async () => {
  // Le deplacement est un rattrapage, pas une habitude : un point pose au bon
  // endroit doit rester ou il est.
  const r = await genere({ lat: 48.3602, lon: -4.5712, cibleM: 5000,
                           niveau: "normal", source });
  assert.equal(r.deplaceDepart, 0);
  assert.equal(r.deplaceArrivee, 0);
});

test("reseau reel : une arrivee coupee est deplacee de la meme facon", async () => {
  // L'arrivee vient du meme champ de recherche : elle merite le meme egard.
  const r = await genere({ ...POSE_PROCHE, arrivee: [POSE_COUPEE.lat, POSE_COUPEE.lon],
                           cibleM: 5000, niveau: "normal", source });
  assert.equal(r.boucle, false);
  assert.ok(r.deplaceArrivee > 100, `arrivee deplacee de ${r.deplaceArrivee.toFixed(0)} m`);
  const dernier = r.points[r.points.length - 1];
  const reel = distanceHaversine(POSE_COUPEE.lat, POSE_COUPEE.lon, dernier[0], dernier[1]);
  assert.ok(Math.abs(reel - r.deplaceArrivee) < 1,
    `annonce ${r.deplaceArrivee.toFixed(0)} m, reel ${reel.toFixed(0)} m`);
});

test("reseau reel : un point vraiment hors de portee est refuse clairement", async () => {
  // En pleine mer, il n'y a rien a accrocher : il faut le dire, pas inventer.
  await assert.rejects(
    genere({ lat: 48.330, lon: -4.560, cibleM: 5000, niveau: "normal", source }),
    (e) => e instanceof BoucleIntrouvable);
});
