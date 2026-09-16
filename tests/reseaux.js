// Reseaux fabriques partages par les tests.
const COS47 = Math.cos(47 * Math.PI / 180);
export const dlon = (m) => m / 111320 / COS47;
export const dlat = (m) => m / 111320;

/**
 * Damier, plus un couloir en echelle qui depasse a l'ouest : une rue, son
 * trottoir cartographie a part 12 m au nord, et des traversees tous les 50 m.
 * C'est la configuration de la capture d'ecran : aller par la rue et revenir
 * par le trottoir emprunte deux aretes distinctes, donc invisible pour un
 * comptage de repetition base sur les identifiants.
 */
export function reseauCouloir(longueurCouloir = 200) {
  let idN = 1, idV = 1;
  const voies = [], g = [];
  const N = 9, PAS = 0.0015;
  for (let i = 0; i < N; i++) {
    g.push([]);
    for (let j = 0; j < N; j++) g[i].push([idN++, 47 + i * PAS, 5 + j * PAS]);
  }
  const voie = (pts, tags) => voies.push({
    type: "way", id: idV++, tags,
    nodes: pts.map((p) => p[0]),
    geometry: pts.map((p) => ({ lat: p[1], lon: p[2] })),
  });
  const rue = { highway: "residential", surface: "asphalt" };
  const trottoir = { highway: "footway", surface: "asphalt" };
  for (let i = 0; i < N; i++) voie(g[i], rue);
  for (let j = 0; j < N; j++) voie(g.map((l) => l[j]), rue);

  const base = g[4][0];
  const pas = 50, n = Math.round(longueurCouloir / pas);
  const sud = [base], nord = [[idN++, base[1] + dlat(12), base[2]]];
  for (let k = 1; k <= n; k++) {
    sud.push([idN++, base[1], base[2] - dlon(k * pas)]);
    nord.push([idN++, base[1] + dlat(12), base[2] - dlon(k * pas)]);
  }
  voie(sud, rue);
  voie(nord, trottoir);
  voie([base, nord[0]], trottoir);
  for (let k = 1; k <= n; k++) voie([sud[k], nord[k]], trottoir);

  return { voies, depart: g[4][4], base, pointe: sud[n] };
}

export const sourceDe = (voies) => ({
  reseau: async () => voies,
  itineraires: async () => new Set(),
  barrieres: async () => [],
});
