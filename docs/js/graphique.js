// Profil altimetrique, en SVG.
//
// Une seule serie, l'altitude en fonction de la distance parcourue. La couleur
// de l'aire ne repete pas l'altitude : elle porte la pente, c'est-a-dire ce
// que la courbe ne dit pas d'un coup d'oeil. L'echelle est divergente autour
// du plat — un bras froid pour la descente, un bras chaud pour la montee, un
// gris neutre au milieu — parce que la pente est une grandeur signee et que
// son zero est un vrai zero.
//
// Les couleurs ne sont pas ecrites ici : ce sont des variables CSS, pour que
// le theme sombre ait ses propres teintes plutot qu'un eclaircissement
// automatique de celles du theme clair.

import { classePente, CLASSES_PENTE } from "./altitude.js";

const LARGEUR = 320, HAUTEUR = 128;
const MARGE = { gauche: 32, droite: 6, haut: 8, bas: 20 };
const TRACE = {
  x0: MARGE.gauche, x1: LARGEUR - MARGE.droite,
  y0: MARGE.haut, y1: HAUTEUR - MARGE.bas,
};

const echappe = (texte) => String(texte).replace(/[&<>"]/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const arrondi = (v) => Math.round(v * 100) / 100;

/**
 * Distance en kilometres. Le nombre de decimales se decide sur la longueur
 * totale, pas sur chaque valeur : sinon la meme graduation afficherait 6,0
 * puis 12, et l'axe aurait l'air bancal.
 */
const km = (m, total) => (m / 1000).toFixed(total >= 10000 ? 0 : 1);

/**
 * Renvoie le SVG du profil. `profil` vient de altitude.js ; null si le relief
 * n'a pas pu etre lu, auquel cas l'appelant n'affiche rien.
 */
export function svgProfil(profil, { titre = "Profil du parcours" } = {}) {
  if (!profil || profil.altitudes.length < 2) return "";
  const { distances, altitudes, pentes, mini, maxi, longueur } = profil;

  // Une marge verticale, et un plancher d'amplitude : sur un parcours plat,
  // un axe colle aux valeurs transformerait trois metres en montagne.
  const amplitude = Math.max(maxi - mini, 20);
  const centre = (maxi + mini) / 2;
  const bas = centre - amplitude * 0.6, haut = centre + amplitude * 0.6;

  const px = (d) => TRACE.x0 + (d / longueur) * (TRACE.x1 - TRACE.x0);
  const py = (a) => TRACE.y1 - ((a - bas) / (haut - bas)) * (TRACE.y1 - TRACE.y0);

  // L'aire se decoupe en suites de segments de meme classe de pente. Les
  // suites sont jointives : un ecart entre elles se lirait comme une donnee
  // manquante, alors que le parcours, lui, est continu.
  const aires = [];
  let debut = 0;
  for (let i = 0; i <= pentes.length; i++) {
    const classe = i < pentes.length ? classePente(pentes[i]).cle : null;
    const precedente = classePente(pentes[debut]).cle;
    if (i === pentes.length || classe !== precedente) {
      const points = [];
      for (let k = debut; k <= i; k++) points.push(`${arrondi(px(distances[k]))} ${arrondi(py(altitudes[k]))}`);
      aires.push(`<path class="aire ${precedente}" d="M${arrondi(px(distances[debut]))} `
        + `${arrondi(TRACE.y1)} L${points.join(" L")} L${arrondi(px(distances[i]))} `
        + `${arrondi(TRACE.y1)} Z"/>`);
      debut = i;
    }
  }

  const ligne = altitudes
    .map((a, i) => `${arrondi(px(distances[i]))} ${arrondi(py(a))}`).join(" L");

  // Deux reperes d'altitude seulement : la courbe est le sujet, pas la grille.
  const reperes = [maxi, mini].map((a) => `<line class="grille" x1="${TRACE.x0}" `
    + `y1="${arrondi(py(a))}" x2="${TRACE.x1}" y2="${arrondi(py(a))}"/>`
    + `<text class="repere" x="${TRACE.x0 - 5}" y="${arrondi(py(a)) + 3}" `
    + `text-anchor="end">${Math.round(a)}</text>`).join("");

  const abscisses = [0, longueur / 2, longueur].map((d, i) =>
    `<text class="repere" x="${arrondi(px(d))}" y="${TRACE.y1 + 13}" `
    + `text-anchor="${i === 0 ? "start" : i === 2 ? "end" : "middle"}">`
    + `${km(d, longueur)}${i === 2 ? " km" : ""}</text>`).join("");

  return `<svg class="profil" viewBox="0 0 ${LARGEUR} ${HAUTEUR}" `
    + `role="img" aria-label="${echappe(titre)}">`
    + `<title>${echappe(titre)}</title>`
    + reperes
    + `<g class="aires">${aires.join("")}</g>`
    + `<polyline class="crete" points="${ligne}"/>`
    + `<line class="viseur" x1="0" y1="${TRACE.y0}" x2="0" y2="${TRACE.y1}" hidden/>`
    + `<circle class="point" r="3.5" cx="0" cy="0" hidden/>`
    + abscisses
    + `<rect class="capteur" x="${TRACE.x0}" y="${TRACE.y0}" `
    + `width="${TRACE.x1 - TRACE.x0}" height="${TRACE.y1 - TRACE.y0}" fill="none" `
    + `pointer-events="all"/>`
    + `</svg>`;
}

/** Legende des classes de pente : la couleur seule ne dit jamais l'identite. */
export function legendePentes() {
  return `<ul class="legende">` + CLASSES_PENTE.map((c) =>
    `<li><i class="pastille ${c.cle}"></i>${echappe(c.libelle)}</li>`).join("")
    + `</ul>`;
}

/**
 * Indice de l'echantillon le plus proche d'une abscisse, en coordonnees du
 * viewBox. Renvoie -1 hors du trace.
 */
export function indiceEn(x, profil) {
  if (!profil || !profil.distances.length) return -1;
  const part = (x - TRACE.x0) / (TRACE.x1 - TRACE.x0);
  if (part < -0.02 || part > 1.02) return -1;
  const vise = Math.min(1, Math.max(0, part)) * profil.longueur;
  let meilleur = 0;
  for (let i = 1; i < profil.distances.length; i++) {
    if (Math.abs(profil.distances[i] - vise) < Math.abs(profil.distances[meilleur] - vise)) {
      meilleur = i;
    }
  }
  return meilleur;
}

/** Position, en coordonnees du viewBox, de l'echantillon `i`. */
export function positionDe(i, profil) {
  const amplitude = Math.max(profil.maxi - profil.mini, 20);
  const centre = (profil.maxi + profil.mini) / 2;
  const bas = centre - amplitude * 0.6, haut = centre + amplitude * 0.6;
  return [
    TRACE.x0 + (profil.distances[i] / profil.longueur) * (TRACE.x1 - TRACE.x0),
    TRACE.y1 - ((profil.altitudes[i] - bas) / (haut - bas)) * (TRACE.y1 - TRACE.y0),
  ];
}

export const CADRE = { LARGEUR, HAUTEUR, TRACE };
