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

    const nom = nomTrace(p.km, !p.arrivee);
    self.postMessage({
      type: "fini",
      resultat: {
        points: resultat.points,
        distance: resultat.distance,
        cible: resultat.cible,
        repetee: resultat.repetee,
        accroche: resultat.accroche,
        longueurBoucle: resultat.longueurBoucle,
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
