// Acces aux donnees OpenStreetMap depuis le navigateur.
//
// Les miroirs Overpass sont des machines benevoles. On ne les interroge pas
// tous d'emblee, ce serait tripler la charge : on en sollicite un de plus
// seulement si le precedent tarde. Les reponses sont mises en cache dans le
// navigateur, donc une meme zone n'est telechargee qu'une fois par visiteur.

export class DonneesIndisponibles extends Error {}

export const MIROIRS = [
  "https://overpass.openstreetmap.fr/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
];

const BASE = "generateur-boucle";
const MAGASIN = "overpass";
const PEREMPTION = 1000 * 60 * 60 * 24 * 30;      // 30 jours

// --- cache ----------------------------------------------------------------
function ouvreBase() {
  return new Promise((resoudre, rejeter) => {
    if (typeof indexedDB === "undefined") return resoudre(null);
    const demande = indexedDB.open(BASE, 1);
    demande.onupgradeneeded = () => {
      const base = demande.result;
      if (!base.objectStoreNames.contains(MAGASIN)) base.createObjectStore(MAGASIN);
    };
    demande.onsuccess = () => resoudre(demande.result);
    demande.onerror = () => resoudre(null);       // sans cache, on continue
    setTimeout(() => resoudre(null), 3000);
  });
}

async function litCache(cle) {
  try {
    const base = await ouvreBase();
    if (!base) return null;
    return await new Promise((resoudre) => {
      const demande = base.transaction(MAGASIN, "readonly")
        .objectStore(MAGASIN).get(cle);
      demande.onsuccess = () => {
        const valeur = demande.result;
        if (!valeur || Date.now() - valeur.date > PEREMPTION) return resoudre(null);
        resoudre(valeur.elements);
      };
      demande.onerror = () => resoudre(null);
    });
  } catch (e) { return null; }
}

async function ecritCache(cle, elements) {
  try {
    const base = await ouvreBase();
    if (!base) return;
    base.transaction(MAGASIN, "readwrite").objectStore(MAGASIN)
      .put({ date: Date.now(), elements }, cle);
  } catch (e) { /* quota plein ou navigation privee : tant pis */ }
}

export async function videCache() {
  const base = await ouvreBase();
  if (!base) return;
  base.transaction(MAGASIN, "readwrite").objectStore(MAGASIN).clear();
}

// --- interrogation --------------------------------------------------------
const hote = (miroir) => new URL(miroir).host;

async function interroge(requete, cle, rafraichir, libelle, journal,
                         { delaiMiroir = 25000, delaiAbandon = 240000,
                           exigeElements = false } = {}) {
  if (!rafraichir) {
    const cache = await litCache(cle);
    if (cache) {
      journal(`  ${libelle} : relu du cache (${cache.length} elements)`);
      return cache;
    }
  }

  const corps = new URLSearchParams({ data: requete });
  const debut = Date.now();
  const echecs = [];
  let lances = 0, termines = 0;
  let resoudre, rejeter;
  const promesse = new Promise((r, j) => { resoudre = r; rejeter = j; });
  let fini = false;

  const abandon = (miroir) => new AbortController();

  const lance = () => {
    if (fini || lances >= MIROIRS.length) return;
    const miroir = MIROIRS[lances++];
    journal(`  ${libelle} : interrogation de ${hote(miroir)}`);
    const controleur = abandon(miroir);
    const minuteur = setTimeout(() => controleur.abort(), delaiAbandon);

    fetch(miroir, { method: "POST", body: corps, signal: controleur.signal })
      .then((reponse) => {
        if (!reponse.ok) throw new Error(`HTTP ${reponse.status}`);
        return reponse.json();
      })
      .then((donnees) => {
        clearTimeout(minuteur);
        if (fini) return;
        const elements = donnees.elements || [];
        if (exigeElements && !elements.length) {
          // Certains serveurs ne couvrent qu'une region : ils repondent
          // "rien trouve" au lieu d'une erreur. On passe au suivant.
          throw new Error("aucune donnee pour cette zone");
        }
        fini = true;
        journal(`  ${libelle} : ${elements.length} elements recus de `
              + `${hote(miroir)} en ${((Date.now() - debut) / 1000).toFixed(0)} s`);
        ecritCache(cle, elements);
        resoudre(elements);
      })
      .catch((erreur) => {
        clearTimeout(minuteur);
        if (fini) return;
        termines++;
        echecs.push(`${hote(miroir)} : ${erreur.message}`);
        journal(`    ${hote(miroir)} indisponible (${erreur.message})`);
        if (lances < MIROIRS.length) lance();
        else if (termines >= lances) {
          fini = true;
          rejeter(new DonneesIndisponibles(
            "Impossible de recuperer les donnees OpenStreetMap "
            + `(${echecs.join(" ; ")}). La praticabilite ne peut pas etre `
            + "verifiee sans elles : aucun trace ne sera genere plutot qu'un "
            + "trace non verifie. Reessayer dans une minute."));
        }
      });
  };

  lance();
  const echelonne = setInterval(() => {
    if (fini || lances >= MIROIRS.length) return clearInterval(echelonne);
    lance();
  }, delaiMiroir);

  const rappel = setInterval(() => {
    if (fini) return clearInterval(rappel);
    journal(`  ${libelle} : toujours en attente `
          + `(${((Date.now() - debut) / 1000).toFixed(0)} s)`);
  }, 15000);

  try {
    return await promesse;
  } finally {
    fini = true;
    clearInterval(echelonne);
    clearInterval(rappel);
  }
}

function boite(lat, lon, rayonM) {
  const degreLat = rayonM / 111320.0;
  const degreLon = rayonM / (111320.0 * Math.max(Math.cos(lat * Math.PI / 180), 0.01));
  return [lat - degreLat, lon - degreLon, lat + degreLat, lon + degreLon]
    .map((v) => v.toFixed(6)).join(",");
}

// Cle de cache : la zone arrondie plutot que le point exact, pour que deux
// departs voisins reutilisent le meme telechargement.
const cle = (nom, lat, lon, rayon) =>
  `${nom}:${lat.toFixed(2)}:${lon.toFixed(2)}:${Math.round(rayon / 500)}`;

export function sourceOverpass() {
  return {
    async reseau(lat, lon, rayon, rafraichir, journal) {
      const requete = `[out:json][timeout:300];way(${boite(lat, lon, rayon)})`
                    + `["highway"];out geom;`;
      const elements = await interroge(
        requete, cle("reseau", lat, lon, rayon), rafraichir, "reseau", journal,
        { delaiMiroir: 20000 + rayon * 5, delaiAbandon: 120000 + rayon * 40,
          exigeElements: true });
      const voies = elements.filter((e) => e.type === "way");
      if (!voies.length) {
        throw new DonneesIndisponibles("Aucune voie trouvee autour de ce point.");
      }
      return voies;
    },

    async itineraires(lat, lon, rayon, rafraichir, journal) {
      const requete = `[out:json][timeout:300];rel(${boite(lat, lon, rayon)})`
                    + `["route"~"^(hiking|foot|walking|running)$"];out body;`;
      const elements = await interroge(
        requete, cle("itineraires", lat, lon, rayon), rafraichir,
        "itineraires balises", journal,
        { delaiMiroir: 20000 + rayon * 5, delaiAbandon: 120000 + rayon * 40 });
      const balises = new Set();
      for (const element of elements) {
        if (element.type !== "relation") continue;
        for (const membre of (element.members || [])) {
          if (membre.type === "way") balises.add(membre.ref);
        }
      }
      return balises;
    },

    async barrieres(lat, lon, rayon, rafraichir, journal) {
      const requete = `[out:json][timeout:180];node(around:${rayon.toFixed(0)},`
                    + `${lat.toFixed(6)},${lon.toFixed(6)})["barrier"];out tags;`;
      return interroge(requete, cle("barrieres", lat, lon, rayon), rafraichir,
                       "barrieres", journal, { delaiMiroir: 20000 });
    },
  };
}

/**
 * Recherche d'adresse. Nominatim interdit explicitement les usages de type
 * autocomplete : cette fonction n'est donc appelee que sur validation, jamais
 * a la frappe. Voir la revue de conformite du depot.
 */
export async function chercheAdresse(texte) {
  const url = "https://nominatim.openstreetmap.org/search?format=json&limit=5&q="
            + encodeURIComponent(texte);
  const reponse = await fetch(url, { headers: { Accept: "application/json" } });
  if (!reponse.ok) throw new Error(`HTTP ${reponse.status}`);
  return reponse.json();
}
