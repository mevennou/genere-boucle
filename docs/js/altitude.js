// Relief du parcours.
//
// L'altitude vient de tuiles de modele numerique de terrain, au format
// Terrarium : un PNG ordinaire ou l'altitude est encodee dans les trois
// canaux de couleur. On telecharge ces tuiles et on les decode ici, dans le
// navigateur, exactement comme le reseau OpenStreetMap est telecharge puis
// transforme en graphe sur la machine du visiteur.
//
// Ce choix n'est pas qu'esthetique. Un service d'altitude prendrait en entree
// la liste des points du parcours : il saurait ou tu cours, metre pour metre.
// Une tuile, elle, couvre plusieurs kilometres carres et ne dit rien du trace
// qu'on y lit. Le serveur ne recoit donc que des numeros de tuiles.

const MODELE = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";
const ZOOM = 13;                 // environ 19 m par pixel a nos latitudes
const COTE = 256;                // pixels par tuile

export const SOURCE_RELIEF =
  "Terrarium (AWS Open Data) — SRTM, NED et sources nationales";

/** Coordonnees en pixels du monde entier, au zoom retenu. */
export function pixelMonde(lat, lon, zoom = ZOOM) {
  const n = Math.pow(2, zoom) * COTE;
  const phi = lat * Math.PI / 180;
  const y = (1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2;
  return [(lon + 180) / 360 * n, y * n];
}

/** Altitude encodee par un pixel Terrarium. */
export const decodePixel = (r, v, b) => (r * 256 + v + b / 256) - 32768;

const cache = new Map();         // "z/x/y" -> Float32Array ou null

/**
 * Telecharge et decode une tuile. Renvoie null si elle manque : au large, en
 * mer, le modele n'a rien a dire, et ce n'est pas une erreur.
 */
export async function chargeTuile(x, y, zoom = ZOOM, charge = chargeImage) {
  const cle = `${zoom}/${x}/${y}`;
  if (cache.has(cle)) return cache.get(cle);
  const promesse = charge(`${MODELE}/${cle}.png`).then((donnees) => {
    if (!donnees) return null;
    const altitudes = new Float32Array(COTE * COTE);
    for (let i = 0; i < altitudes.length; i++) {
      altitudes[i] = decodePixel(donnees[i * 4], donnees[i * 4 + 1], donnees[i * 4 + 2]);
    }
    return altitudes;
  }).catch(() => null);
  cache.set(cle, promesse);
  return promesse;
}

/** Lecture des pixels d'une image distante, via un canevas. */
function chargeImage(url) {
  return new Promise((resoudre, rejeter) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      const canevas = document.createElement("canvas");
      canevas.width = COTE; canevas.height = COTE;
      const contexte = canevas.getContext("2d", { willReadFrequently: true });
      contexte.drawImage(image, 0, 0);
      resoudre(contexte.getImageData(0, 0, COTE, COTE).data);
    };
    image.onerror = () => rejeter(new Error("tuile de relief indisponible"));
    image.src = url;
  });
}

/** Altitude interpolee entre les quatre pixels voisins. */
export function altitudeEn(lat, lon, tuiles, zoom = ZOOM) {
  const [wx, wy] = pixelMonde(lat, lon, zoom);
  const lis = (px, py) => {
    const tx = Math.floor(px / COTE), ty = Math.floor(py / COTE);
    const tuile = tuiles.get(`${zoom}/${tx}/${ty}`);
    if (!tuile) return null;
    const ix = Math.min(COTE - 1, Math.max(0, Math.floor(px) - tx * COTE));
    const iy = Math.min(COTE - 1, Math.max(0, Math.floor(py) - ty * COTE));
    return tuile[iy * COTE + ix];
  };
  const x0 = Math.floor(wx - 0.5), y0 = Math.floor(wy - 0.5);
  const fx = wx - 0.5 - x0, fy = wy - 0.5 - y0;
  const a = lis(x0, y0), b = lis(x0 + 1, y0);
  const c = lis(x0, y0 + 1), d = lis(x0 + 1, y0 + 1);
  if (a === null || b === null || c === null || d === null) return null;
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy)
       + c * (1 - fx) * fy + d * fx * fy;
}

/** Toutes les tuiles couvrant une suite de points. */
export function tuilesNecessaires(points, zoom = ZOOM) {
  const besoins = new Set();
  for (const [lat, lon] of points) {
    const [wx, wy] = pixelMonde(lat, lon, zoom);
    // Les voisines aussi : l'interpolation lit un pixel de part et d'autre.
    for (const dx of [-1, 1]) {
      for (const dy of [-1, 1]) {
        besoins.add(`${zoom}/${Math.floor((wx + dx) / COTE)}/${Math.floor((wy + dy) / COTE)}`);
      }
    }
  }
  return [...besoins];
}

const RAD = Math.PI / 180;
function distance(a, b) {
  const dlat = (b[0] - a[0]) * 111320;
  const dlon = (b[1] - a[1]) * 111320 * Math.cos(a[0] * RAD);
  return Math.hypot(dlat, dlon);
}

/**
 * Reechantillonne le trace a pas constant. Le profil se lit en fonction de la
 * distance parcourue, pas du nombre de points : un long tronçon rectiligne ne
 * doit pas peser moins qu'une enfilade de petites rues.
 */
export function echantillonne(points, pas = 25) {
  if (!points || points.length < 2) return { points: (points || []).slice(), distances: [0] };
  const sortie = [points[0]];
  // Distances comptees le long du chemin, pas a vol d'oiseau : a un coude,
  // deux echantillons distants de 25 m de parcours sont plus proches que 25 m
  // en ligne droite, et le profil serait decale d'autant.
  const distances = [0];
  let cumul = 0, reste = pas;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i], b = points[i + 1];
    const segment = distance(a, b);
    if (segment === 0) continue;
    let parcouru = 0;
    while (parcouru + reste <= segment) {
      parcouru += reste;
      cumul += reste;
      const t = parcouru / segment;
      sortie.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      distances.push(cumul);
      reste = pas;
    }
    const fin = segment - parcouru;
    cumul += fin;
    reste -= fin;
  }
  const dernier = points[points.length - 1];
  if (cumul - distances[distances.length - 1] > pas / 2) {
    sortie.push(dernier);
    distances.push(cumul);
  }
  return { points: sortie, distances };
}

/**
 * Moyenne glissante, pour le dessin seulement.
 *
 * Elle n'a pas sa place dans le calcul du denivele : sur un plateau vu a
 * quelques metres pres, meme une large fenetre laisse passer des dizaines de
 * metres de relief imaginaire, et elle rabote au passage les vraies cotes.
 * C'est le seuil d'accumulation, plus bas, qui fait ce travail. Ici, on ne
 * cherche qu'a eviter une ligne en dents de scie.
 */
export function lisse(altitudes, fenetre = 3) {
  const demi = Math.floor(fenetre / 2);
  if (altitudes.length < 3 || demi < 1) return altitudes.slice();
  const sortie = new Array(altitudes.length);
  for (let i = 0; i < altitudes.length; i++) {
    let somme = 0, nombre = 0;
    for (let k = Math.max(0, i - demi); k <= Math.min(altitudes.length - 1, i + demi); k++) {
      somme += altitudes[k]; nombre++;
    }
    sortie[i] = somme / nombre;
  }
  return sortie;
}

/**
 * Denivele positif et negatif, par seuil d'accumulation.
 *
 * Un modele numerique de terrain se trompe de quelques metres a la verticale,
 * a chaque point. Additionner naivement les differences revient a additionner
 * ce bruit : sur dix kilometres de plat, on obtient deux cent soixante metres
 * de denivele qui n'existent pas. On ne compte donc une montee qu'a partir du
 * moment ou elle depasse `seuil` metres depuis le dernier point de reference.
 * Le prix a payer est borne : au plus `seuil` metres par versant reel.
 */
export function denivele(altitudes, seuil = 3) {
  let montee = 0, descente = 0;
  if (!altitudes.length) return { montee, descente };
  let reference = altitudes[0];
  for (const valeur of altitudes) {
    if (valeur > reference + seuil) { montee += valeur - reference; reference = valeur; }
    else if (valeur < reference - seuil) { descente += reference - valeur; reference = valeur; }
  }
  return { montee, descente };
}

/** Classes de pente, en pourcentage. Echelle divergente autour du plat. */
export const CLASSES_PENTE = [
  { cle: "descente-forte", jusqua: -8, libelle: "≤ −8 %" },
  { cle: "descente", jusqua: -3, libelle: "−8 à −3 %" },
  { cle: "plat", jusqua: 3, libelle: "± 3 %" },
  { cle: "montee", jusqua: 8, libelle: "3 à 8 %" },
  { cle: "montee-forte", jusqua: Infinity, libelle: "≥ 8 %" },
];

export function classePente(pourcentage) {
  return CLASSES_PENTE.find((c) => pourcentage <= c.jusqua) || CLASSES_PENTE[4];
}

/**
 * Profil altimetrique complet. Renvoie null si le relief est indisponible :
 * le parcours reste affiche, seul le profil manque.
 */
/**
 * Pente en pourcentage, mesuree sur une longueur qu'on parcourt reellement.
 *
 * Entre deux echantillons distants de vingt-cinq metres, le bruit du modele
 * fait basculer la pente d'une classe a l'autre a chaque pas : la courbe se
 * couvre alors de rayures qui ne veulent rien dire. Un coureur ne ressent pas
 * la pente sur vingt-cinq metres, il la ressent sur cent cinquante : c'est
 * cette longueur-la qu'on mesure.
 */
export function pentes(altitudes, distances, portee = 150) {
  const sortie = [];
  for (let i = 0; i + 1 < altitudes.length; i++) {
    const milieu = (distances[i] + distances[i + 1]) / 2;
    let a = i, b = i + 1;
    while (a > 0 && milieu - distances[a] < portee / 2) a--;
    while (b < altitudes.length - 1 && distances[b] - milieu < portee / 2) b++;
    const avance = distances[b] - distances[a];
    sortie.push(avance > 0 ? ((altitudes[b] - altitudes[a]) / avance) * 100 : 0);
  }
  return sortie;
}

export async function profil(points, { pas = 25, fenetre = 7, seuil = 3,
                                       portee = 150, chargeur = chargeTuile } = {}) {
  if (!points || points.length < 2) return null;
  const { points: echantillons, distances } = echantillonne(points, pas);
  if (echantillons.length < 2) return null;

  const tuiles = new Map();
  await Promise.all(tuilesNecessaires(echantillons).map(async (cle) => {
    const [z, x, y] = cle.split("/").map(Number);
    tuiles.set(cle, await chargeur(x, y, z));
  }));
  if (![...tuiles.values()].some(Boolean)) return null;

  const brutes = echantillons.map(([lat, lon]) => altitudeEn(lat, lon, tuiles));
  if (brutes.some((a) => a === null)) return null;

  // Le denivele se mesure sur les altitudes brutes, avec un seuil ; la courbe
  // se dessine sur des altitudes lissees, pour ne pas etre en dents de scie.
  const { montee, descente } = denivele(brutes, seuil);
  const altitudes = lisse(brutes, fenetre);

  return {
    distances, altitudes, pentes: pentes(altitudes, distances, portee),
    montee, descente,
    // Les altitudes extremes decrivent le terrain, pas la courbe : le lissage
    // arrondit un sommet pointu de quelques metres, et le point haut du
    // parcours ne doit pas dependre de la facon dont on le dessine.
    mini: Math.min(...brutes), maxi: Math.max(...brutes),
    longueur: distances[distances.length - 1],
  };
}
