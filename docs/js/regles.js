// Regles de praticabilite. Portage strict de evalue_voie et de ses tables.
// Renvoyer null = la voie n'entre pas dans le graphe, donc l'itineraire ne
// pourra jamais l'emprunter. C'est ici que se joue le filtrage.

const ens = (...valeurs) => new Set(valeurs);

export const HW_INTERDITS = ens(
  "motorway", "motorway_link", "trunk", "trunk_link",
  "primary", "primary_link", "construction", "proposed", "planned",
  "raceway", "bus_guideway", "busway", "escape", "corridor", "elevator",
  "platform", "rest_area", "services", "emergency_bay", "via_ferrata");

export const COUT_BASE = new Map([
  ["footway", 1.00], ["pedestrian", 1.00], ["cycleway", 1.05], ["path", 1.10],
  ["living_street", 1.10], ["residential", 1.15], ["unclassified", 1.20],
  ["track", 1.25], ["service", 1.35], ["road", 1.60], ["bridleway", 1.70],
  ["tertiary", 1.90], ["tertiary_link", 1.90], ["secondary", 3.20],
  ["secondary_link", 3.20], ["steps", 4.00],
]);

export const SURFACES_DURES = ens(
  "asphalt", "paved", "concrete", "concrete:plates", "concrete:lanes",
  "paving_stones", "sett", "cobblestone", "unhewn_cobblestone", "chipseal",
  "metal", "wood", "compacted", "fine_gravel", "gravel", "pebblestone",
  "rock", "bricks", "grass_paver");
export const SURFACES_MEUBLES = ens("ground", "dirt", "earth", "unpaved", "shells");
export const SURFACES_RISQUEES = ens("grass", "woodchips", "clay", "soil",
                                     "sand", "dirt/sand");
export const SURFACES_INTERDITES = ens("mud", "sand", "snow", "ice", "salt",
                                       "water", "fine_sand");
export const SERVICES_PRIVES = ens("driveway", "parking_aisle", "drive-through",
                                   "emergency_access", "slipway", "bus", "busway");
// Ce qui barre un chemin sans etre une barriere : le tag obstacle decrit un
// encombrement releve sur la voie. En sous-bois, c'est exactement le cas dont
// on se mefie — un arbre en travers, un roncier, un eboulis.
export const OBSTACLES_BLOQUANTS = ens(
  "vegetation", "log", "fallen_tree", "tree", "rockfall", "landslide",
  "boulder", "debris");
export const BARRIERES_INFRANCHISSABLES = ens(
  "wall", "fence", "hedge", "retaining_wall", "city_wall", "ditch",
  "jersey_barrier", "full-height_turnstile", "sally_port", "spikes",
  "hampshire_gate", "guard_rail");

// Routes ouvertes a la circulation, ou le pieton partage la chaussee avec les
// voitures quand rien ne lui est reserve. Les rues residentielles n'en sont
// pas : trafic de desserte, vitesse de ville.
export const ROUTES_PARTAGEES = ens(
  "unclassified", "tertiary", "tertiary_link", "secondary", "secondary_link",
  "road");
// Valeurs qui attestent un espace pieton le long de la chaussee, qu'il soit
// dessine sur la route elle-meme ou cartographie a part.
export const COTES_PIETONS = ens("yes", "both", "left", "right", "separate");
// A partir de cette vitesse, courir sur la chaussee sans trottoir n'est plus
// un inconfort mais un danger.
export const VITESSE_DANGEREUSE = 70;

export const LIBELLES_QUALITE = {
  balise: "itineraire balise",
  dure: "revetement dur",
  meuble: "terre / stabilise",
  voirie: "trottoir / rue",
  inconnue: "chemin nomme ou eclaire",
};

// Python : float(str(valeur).split()[0].replace(",", ".")), qui echoue sur
// "1.5m" la ou parseFloat renverrait 1.5. Le filtrage de largeur en depend :
// une valeur incomprise doit rester inconnue, pas devenir un nombre invente.
const FLOTTANT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

export function nombre(valeur) {
  if (valeur === undefined || valeur === null) return null;
  const premier = String(valeur).trim().split(/\s+/)[0];
  if (!premier) return null;
  const nettoye = premier.replace(/,/g, ".");
  if (!FLOTTANT.test(nettoye)) return null;
  const v = parseFloat(nettoye);
  return Number.isNaN(v) ? null : v;
}

const vide = (v) => v === undefined || v === null;

/**
 * Vitesse autorisee en km/h, ou null si les tags ne la disent pas. La limite
 * peut etre chiffree (« 80 », « 50 mph ») ou implicite (« FR:rural »,
 * « FR:zone30 ») : c'est ainsi qu'est notee une bonne part des routes
 * francaises, qui n'ont pas de panneau mais une regle.
 */
export function vitesseAutorisee(tags) {
  for (const cle of ["maxspeed", "maxspeed:type", "zone:maxspeed", "source:maxspeed"]) {
    const valeur = tags[cle];
    if (!valeur) continue;
    let nature = String(valeur).split(":").pop().trim().toLowerCase();
    if (nature === "rural") return 80.0;
    if (nature === "urban") return 50.0;
    if (nature.startsWith("zone")) nature = nature.slice(4);
    const v = nombre(nature);
    if (v !== null) return String(valeur).includes("mph") ? v * 1.609 : v;
  }
  return null;
}

/**
 * Ce que risque un coureur sur une route sans trottoir ni cheminement
 * reserve : "danger" quand la limite connue est celle d'une route de
 * campagne, "incertaine" quand rien ne la dit, null sinon.
 *
 * Le danger se prouve, il ne se suppose pas. Une limite absente ne vaut pas
 * quatre-vingts : sur le terrain, ce sont surtout des chemins entre hameaux
 * ou des rues de bourg que personne n'a renseignes, et les tenir pour des
 * routes rapides vidait les campagnes de tout parcours. L'eclairage public,
 * lui, signe la traversee d'une agglomeration : la route est alors une rue.
 */
export function expositionRoute(tags) {
  if (!ROUTES_PARTAGEES.has(tags.highway)) return null;
  if (tags.foot === "designated") return null;
  for (const cle of ["sidewalk", "sidewalk:both", "sidewalk:left", "sidewalk:right"]) {
    if (COTES_PIETONS.has(tags[cle])) return null;
  }
  const vitesse = vitesseAutorisee(tags);
  if (vitesse !== null) return vitesse >= VITESSE_DANGEREUSE ? "danger" : null;
  return !vide(tags.lit) && tags.lit !== "no" ? null : "incertaine";
}

/**
 * Renvoie [cout, etiquette, qualite] si la voie est praticable, sinon null.
 * `balise` indique une appartenance a un itineraire de randonnee officiel.
 */
export function evalueVoie(tags, niveau, balise = false) {
  const hw = tags.highway;
  if (!hw || HW_INTERDITS.has(hw) || !COUT_BASE.has(hw)) return null;
  if (tags.area === "yes") return null;          // esplanade cartographiee en surface

  // --- interdictions d'acces ---------------------------------------------
  if (tags.indoor === "yes" || !vide(tags.level)) return null;

  const pied = tags.foot;
  if (pied === "no" || pied === "private" || pied === "destination") return null;
  const autoriseExplicitement = pied === "yes" || pied === "designated"
    || pied === "permissive" || pied === "official";
  if (!autoriseExplicitement) {
    const acces = tags.access;
    if (acces === "no" || acces === "private" || acces === "customers"
        || acces === "permit" || acces === "military" || acces === "delivery"
        || acces === "agricultural" || acces === "forestry") return null;
  }

  const service = tags.service;
  if (SERVICES_PRIVES.has(service) && niveau !== "tolerant"
      && !(pied === "yes" || pied === "designated" || pied === "official")) {
    return null;
  }

  // Une route de campagne sans trottoir n'est pas une penalite a compenser
  // par une bonne distance : c'est un danger, elle n'entre pas dans le graphe.
  // Seul le niveau tolerant la garde, tres rencherie, pour ne pas laisser sans
  // reponse une campagne ou rien d'autre ne relie les chemins.
  const exposition = expositionRoute(tags);
  if (exposition === "danger" && niveau !== "tolerant") return null;

  // --- obstacles physiques et etat du terrain ----------------------------
  if (!vide(tags.ford) && tags.ford !== "no") return null;
  if (tags.overgrown === "yes") return null;
  if (!vide(tags.seasonal) && tags.seasonal !== "no") return null;
  if (tags.flooded === "yes") return null;
  if (tags.informal === "yes") return null;
  if (tags.abandoned === "yes" || tags.disused === "yes") return null;
  if (OBSTACLES_BLOQUANTS.has(tags.obstacle)) return null;

  const visibilite = tags.trail_visibility;
  const mauvaise = new Set(["bad", "horrible", "no"]);
  if (niveau === "strict") mauvaise.add("intermediate");
  if (mauvaise.has(visibilite)) return null;

  const sac = tags.sac_scale;
  if (!vide(sac) && sac !== "hiking") return null;

  const lissage = tags.smoothness;
  if (lissage === "horrible" || lissage === "very_horrible"
      || lissage === "impassable") return null;
  if (niveau === "strict" && (lissage === "bad" || lissage === "very_bad")) return null;
  // Ornieres et racines en sous-bois : praticable a pied, pas en courant.
  if (niveau !== "tolerant" && lissage === "very_bad"
      && (hw === "path" || hw === "track" || hw === "bridleway")) return null;

  const tracktype = tags.tracktype;
  if (tracktype === "grade4" || tracktype === "grade5") return null;

  const largeur = nombre(tags.width || tags.est_width);
  if (largeur !== null && largeur < 0.6) return null;

  const surface = tags.surface;
  if (SURFACES_INTERDITES.has(surface)) return null;

  // --- qualite du revetement ---------------------------------------------
  if (SURFACES_RISQUEES.has(surface) && niveau !== "tolerant") return null;

  let qualite;
  if (SURFACES_DURES.has(surface) || tracktype === "grade1" || tracktype === "grade2") {
    qualite = "dure";
  } else if (SURFACES_MEUBLES.has(surface) || SURFACES_RISQUEES.has(surface)) {
    qualite = "meuble";
  } else {
    qualite = "inconnue";
  }

  // Un sentier ou chemin rural sans revetement dur est la premiere source de
  // mauvaises surprises : en sous-bois, un arbre tombe ou un roncier suffit a
  // le rendre impraticable, et la carte n'en sait rien. On ne l'accepte donc
  // au niveau normal que s'il porte une preuve d'entretien. La terre battue
  // seule n'en est pas une : c'est le defaut de tous les sentiers oublies.
  const naturel = hw === "path" || hw === "track" || hw === "bridleway";
  if (naturel) {
    if (niveau === "strict" && qualite !== "dure") return null;
    if (qualite !== "dure" && niveau === "normal") {
      const documente = Boolean(tags.name) || balise
        || (!vide(tags.lit) && tags.lit !== "no")
        || visibilite === "excellent" || visibilite === "good"
        || tags.bicycle === "designated" || tags.bicycle === "yes"
        || lissage === "excellent" || lissage === "good" || lissage === "intermediate";
      if (!documente) return null;
    }
  }

  let cout = COUT_BASE.get(hw);
  if (qualite === "meuble") cout *= 1.15;
  else if (qualite === "inconnue") cout *= naturel ? 1.45 : 1.00;
  if (visibilite === "excellent" || visibilite === "good") cout *= 0.90;
  if (tags.name && naturel) cout *= 0.95;
  if (balise) cout *= 0.85;

  if (SERVICES_PRIVES.has(service)) cout *= 2.0;
  else if (service === "alley") cout *= 1.3;

  if (ROUTES_PARTAGEES.has(hw)) {
    if (tags.sidewalk === "no" || tags.sidewalk === "none") cout *= 1.8;
    const vitesse = vitesseAutorisee(tags);
    if (vitesse !== null && vitesse >= VITESSE_DANGEREUSE) cout *= 1.6;
    // Sans limite connue, la route reste un recours : assez chere pour que le
    // moindre chemin ou trottoir parallele l'emporte, pas au point de couper
    // les hameaux les uns des autres.
    if (exposition === "danger") cout *= 3.0;
    else if (exposition === "incertaine") cout *= 1.5;
  }

  if (!naturel && qualite === "inconnue") qualite = "voirie";
  return [cout, hw, balise ? "balise" : qualite];
}

/** Identifiants OSM des noeuds qu'on ne peut pas franchir a pied. */
export function noeudsInfranchissables(elements) {
  const bloques = new Set();
  for (const element of elements) {
    if (element.type !== "node") continue;
    const tags = element.tags || {};
    const barriere = tags.barrier;
    if (!barriere) continue;
    const pied = tags.foot;
    if (pied === "yes" || pied === "designated" || pied === "permissive"
        || pied === "official") continue;
    if (pied === "no" || pied === "private") { bloques.add(element.id); continue; }
    if (tags.locked === "yes") { bloques.add(element.id); continue; }
    const acces = tags.access;
    if (acces === "no" || acces === "private" || acces === "customers"
        || acces === "permit" || acces === "military" || acces === "delivery") {
      bloques.add(element.id); continue;
    }
    if (BARRIERES_INFRANCHISSABLES.has(barriere)) bloques.add(element.id);
  }
  return bloques;
}
