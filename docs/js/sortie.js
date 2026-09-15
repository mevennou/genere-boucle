// Production des fichiers de sortie.

export function repartition(trajet, aretes, champ) {
  const totaux = new Map();
  for (const [index] of trajet) {
    const cle = aretes[index][champ];
    totaux.set(cle, (totaux.get(cle) || 0) + aretes[index].longueur);
  }
  return [...totaux.entries()].sort((a, b) => b[1] - a[1]);
}

export function allege(points, maximum) {
  if (points.length <= maximum) return points;
  const pas = Math.ceil(points.length / maximum);
  const reduit = [];
  for (let i = 0; i < points.length; i += pas) reduit.push(points[i]);
  const dernier = points[points.length - 1];
  const fin = reduit[reduit.length - 1];
  if (fin[0] !== dernier[0] || fin[1] !== dernier[1]) reduit.push(dernier);
  return reduit;
}

const echappe = (texte) => String(texte)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

/**
 * GPX 1.1. Le bloc <copyright> fait voyager l'attribution ODbL avec le
 * fichier, et pas seulement avec le site : la trace derive des donnees
 * OpenStreetMap, y compris une fois importee dans une montre.
 */
export function ecritGPX(points, nom) {
  const lignes = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="generateur-boucle-gpx"',
    '     xmlns="http://www.topografix.com/GPX/1/1"',
    '     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    '     xsi:schemaLocation="http://www.topografix.com/GPX/1/1'
    + ' http://www.topografix.com/GPX/1/1/gpx.xsd">',
    "  <metadata>",
    `    <name>${echappe(nom)}</name>`,
    '    <copyright author="OpenStreetMap contributors">',
    "      <license>https://opendatacommons.org/licenses/odbl/</license>",
    "    </copyright>",
    "  </metadata>",
    "  <trk>",
    `    <name>${echappe(nom)}</name>`,
    "    <trkseg>",
  ];
  for (const [lat, lon] of points) {
    lignes.push(`      <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"></trkpt>`);
  }
  lignes.push("    </trkseg>", "  </trk>", "</gpx>", "");
  return lignes.join("\n");
}

export function ecritGeoJSON(points) {
  return JSON.stringify({
    type: "Feature",
    properties: { attribution: "© les contributeurs OpenStreetMap, ODbL" },
    geometry: { type: "LineString", coordinates: points.map(([lat, lon]) => [lon, lat]) },
  });
}

const deuxChiffres = (n) => String(n).padStart(2, "0");

export function nomHorodate(km, date = new Date()) {
  const d = `${date.getFullYear()}-${deuxChiffres(date.getMonth() + 1)}-`
          + `${deuxChiffres(date.getDate())}_${deuxChiffres(date.getHours())}h`
          + `${deuxChiffres(date.getMinutes())}`;
  return `${d}_${km.toFixed(1)}km.gpx`;
}

export function nomTrace(km, boucle = true, date = new Date()) {
  const d = `${deuxChiffres(date.getDate())}/${deuxChiffres(date.getMonth() + 1)}/`
          + date.getFullYear();
  return `${boucle ? "Boucle" : "Parcours"} ${km.toFixed(1)} km du ${d}`;
}
