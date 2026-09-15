// Geometrie spherique. Portage strict des fonctions Python homonymes :
// distance_haversine, cap_entre, point_a_distance, boite_englobante.
export const RAYON_TERRE = 6371008.8;

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

export function distanceHaversine(lat1, lon1, lat2, lon2) {
  const phi1 = lat1 * RAD, phi2 = lat2 * RAD;
  const dphi = (lat2 - lat1) * RAD;
  const dlambda = (lon2 - lon1) * RAD;
  const sdphi = Math.sin(dphi / 2), sdl = Math.sin(dlambda / 2);
  const a = sdphi * sdphi + Math.cos(phi1) * Math.cos(phi2) * sdl * sdl;
  return 2 * RAYON_TERRE * Math.asin(Math.sqrt(a));
}

export function capEntre(lat1, lon1, lat2, lon2) {
  const phi1 = lat1 * RAD, phi2 = lat2 * RAD;
  const dlambda = (lon2 - lon1) * RAD;
  const y = Math.sin(dlambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2)
          - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dlambda);
  // Python : math.degrees(atan2(y, x)) % 360.0 -- le modulo Python rend
  // toujours un resultat positif, contrairement a celui de JavaScript.
  return moduloPositif(Math.atan2(y, x) * DEG, 360);
}

export function pointADistance(lat, lon, capDeg, distanceM) {
  const d = distanceM / RAYON_TERRE;
  const cap = capDeg * RAD;
  const lat1 = lat * RAD, lon1 = lon * RAD;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d)
                       + Math.cos(lat1) * Math.sin(d) * Math.cos(cap));
  const lon2 = lon1 + Math.atan2(Math.sin(cap) * Math.sin(d) * Math.cos(lat1),
                                 Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return [lat2 * DEG, moduloPositif(lon2 * DEG + 540, 360) - 180];
}

export function boiteEnglobante(lat, lon, rayonM) {
  const degreLat = rayonM / 111320.0;
  const degreLon = rayonM / (111320.0 * Math.max(Math.cos(lat * RAD), 0.01));
  return [lat - degreLat, lon - degreLon, lat + degreLat, lon + degreLon]
    .map((v) => v.toFixed(6)).join(",");
}

// Le modulo de JavaScript garde le signe du dividende (-10 % 360 = -10),
// celui de Python garde celui du diviseur (-10 % 360 = 350). Tout le code
// d'orientation repose sur la seconde convention.
export function moduloPositif(valeur, diviseur) {
  return ((valeur % diviseur) + diviseur) % diviseur;
}

// Python arrondit les demis vers le pair (round(0.5) = 0, round(1.5) = 2),
// la ou Math.round arrondit toujours vers le haut. note_boucle compare des
// valeurs arrondies : la regle de depart doit etre la meme, sans quoi deux
// boucles a egalite ne seraient pas departagees pareil.
export function arrondiPython(valeur) {
  const bas = Math.floor(valeur);
  const reste = valeur - bas;
  if (reste > 0.5) return bas + 1;
  if (reste < 0.5) return bas;
  return bas % 2 === 0 ? bas : bas + 1;
}
