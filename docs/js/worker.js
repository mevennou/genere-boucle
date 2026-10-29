// Fil de calcul. Le telechargement et la recherche se font ici, hors du fil
// d'affichage : la carte reste manipulable pendant la generation, et les
// lignes d'avancement remontent au fur et a mesure.

import { genere, BoucleIntrouvable } from "./moteur.js";
import { sourceOverpass, DonneesIndisponibles, videCache } from "./overpass.js";
import { ecritGPX, ecritGeoJSON, nomTrace } from "./sortie.js";

self.onmessage = async (evenement) => {
  const message = evenement.data;

  if (message.type === "vide-cache") {
    await videCache();
    self.postMessage({ type: "cache-vide" });
    return;
  }

  if (message.type !== "generer") return;
  const p = message.parametres;
  const journal = (ligne) => self.postMessage({ type: "journal", ligne: String(ligne) });

  try {
    const resultat = await genere({
      lat: p.lat, lon: p.lon, cibleM: p.km * 1000,
      niveau: p.niveau, arrivee: p.arrivee, rafraichir: p.rafraichir,
      journal, source: sourceOverpass(),
    });

    // Quand le parcours est a refaire plusieurs fois, le nom le dit : c'est
    // lui qu'on lit sur la montre.
    const tours = resultat.tours || 1;
    const nom = tours > 1
      ? nomTrace(resultat.distance / tours / 1000, true, new Date(), tours)
      : nomTrace(p.km, !p.arrivee);
    self.postMessage({
      type: "fini",
      resultat: {
        points: resultat.points,
        distance: resultat.distance,
        cible: resultat.cible,
        repetee: resultat.repetee,
        accroche: resultat.accroche,
        deplaceDepart: resultat.deplaceDepart,
        deplaceArrivee: resultat.deplaceArrivee,
        longueurBoucle: resultat.longueurBoucle,
        // Plus d'un tour quand aucune boucle unique ne tenait la distance : le
        // GPX n'en contient qu'un, l'interface doit dire combien en faire.
        tours: tours,
        // L'interface annonce les portions longees : sans cette mesure, elle
        // les passait sous silence.
        doublement: resultat.doublement,
        portionsDoublees: resultat.portionsDoublees,
        bouclettes: resultat.bouclettes,
        nbBouclettes: resultat.nbBouclettes,
        types: resultat.types,
        qualites: resultat.qualites,
        boucle: resultat.boucle,
        nom,
        gpx: ecritGPX(resultat.points, nom),
        geojson: ecritGeoJSON(resultat.points),
      },
    });
  } catch (erreur) {
    const attendue = erreur instanceof BoucleIntrouvable
                  || erreur instanceof DonneesIndisponibles;
    self.postMessage({
      type: "erreur",
      message: attendue ? erreur.message
                        : `Erreur inattendue : ${erreur && erreur.message}`,
    });
  }
};
