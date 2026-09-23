// Interface. Le calcul est delegue au worker : la carte reste manipulable
// pendant la generation.

import { chercheAdresse } from "./overpass.js";
import { profil, classePente } from "./altitude.js";
import { svgProfil, legendePentes, indiceEn, positionDe } from "./graphique.js";

const $ = (id) => document.getElementById(id);
const bouton = $("btn-generer");
const journal = $("journal");
const barre = $("barre");
const bilan = $("bilan");
const message = $("message");
const champKm = $("km");
const curseur = $("curseur");
const champNiveau = $("niveau");

// Le dernier depart, la derniere distance et le dernier niveau sont retenus
// par le navigateur, sur ce poste uniquement. Ce sont des reglages que
// l'utilisateur a lui-meme choisis : rien n'est transmis, rien n'est trace.
const MEMOIRE = "generateur-boucle:reglages";
function litMemoire() {
  try { return JSON.parse(localStorage.getItem(MEMOIRE) || "null") || {}; }
  catch (e) { return {}; }
}
function ecritMemoire(modifs) {
  try {
    localStorage.setItem(MEMOIRE, JSON.stringify(Object.assign(litMemoire(), modifs)));
  } catch (e) { /* navigation privee : on s'en passe */ }
}
const memoire = litMemoire();
const departConnu = typeof memoire.lat === "number" && typeof memoire.lon === "number";

// --- fonds de carte -------------------------------------------------------
// Uniquement des fonds OpenStreetMap : la couche satellite d'un fournisseur
// commercial a ete retiree faute de licence pour une diffusion publique.
const communs = { keepBuffer: 1, updateWhenZooming: false, maxZoom: 21 };
const fonds = {
  "Plan": L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    Object.assign({ maxNativeZoom: 19,
      attribution: '&copy; les contributeurs <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }, communs)),
  "Plan détaillé (plus lent)": L.tileLayer(
    "https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png",
    Object.assign({ maxNativeZoom: 20, subdomains: "abc",
      attribution: '&copy; OpenStreetMap France' }, communs)),
  "Relief": L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    Object.assign({ maxNativeZoom: 17, subdomains: "abc",
      attribution: '&copy; OpenTopoMap (CC-BY-SA), &copy; OpenStreetMap' }, communs)),
};

const carte = L.map("carte", {
  center: departConnu ? [memoire.lat, memoire.lon] : [46.7, 2.4],
  zoom: departConnu ? (memoire.zoom || 16) : 5,
  layers: [fonds["Plan"]],
  preferCanvas: true,
  zoomControl: false,          // remplace par #outils-carte, visibles au pouce
  tap: false,                  // evite le double declenchement sur iOS
});
L.control.layers(fonds, {}, { position: "topright" }).addTo(carte);
L.control.scale({ imperial: false, position: "bottomleft" }).addTo(carte);

// --- outils de carte ------------------------------------------------------
$("zoom-plus").onclick = () => carte.zoomIn();
$("zoom-moins").onclick = () => carte.zoomOut();
$("recentrer").onclick = () => {
  if (trace) return carte.fitBounds(trace.getBounds(), margeCarte());
  if (marqueur) return carte.setView(marqueur.getLatLng(), Math.max(carte.getZoom(), 16));
};

// --- feuille basse sur mobile --------------------------------------------
// Sur telephone le panneau devient une feuille que l'on replie : sinon il
// mange l'ecran et la carte, qui est l'essentiel, n'a plus de place.
const panneau = $("panneau");
const poignee = $("poignee");
const estMobile = () => typeof window !== "undefined"
  && typeof window.matchMedia === "function"
  && window.matchMedia("(max-width: 720px)").matches;

// La feuille basse recouvre le bas de la carte : sans cela, un cadrage
// centre place la moitie du parcours derriere elle.
function margeCarte() {
  if (!estMobile() || panneau.classList.contains("replie")) {
    return { padding: [40, 40] };
  }
  // Au-dela, il ne resterait plus assez de carte pour cadrer quoi que ce
  // soit et Leaflet reculerait jusqu'au zoom minimal.
  const hauteur = Math.min(panneau.offsetHeight || 0,
                           (window.innerHeight || 0) * 0.45);
  return { paddingTopLeft: [24, 24], paddingBottomRight: [24, hauteur + 24] };
}

function replie(actif) {
  panneau.classList.toggle("replie", actif);
  poignee.setAttribute("aria-expanded", actif ? "false" : "true");
}
poignee.onclick = () => replie(!panneau.classList.contains("replie"));

// --- points de depart et d'arrivee ---------------------------------------
const jetonDepart = $("jeton-depart");
const jetonArrivee = $("jeton-arrivee");
const caseArrivee = $("case-arrivee");
const blocArrivee = $("bloc-arrivee");

let marqueur = null, marqueurArrivee = null, trace = null;
let aPoser = "depart";
// Declare ici et pas plus bas : majCoord le lit des la pose du depart memorise,
// donc avant que le worker ne soit cree.
let enCours = false;

function icone(lettre, couleur) {
  return L.divIcon({
    className: "",
    html: `<div style="width:26px;height:26px;border-radius:50%;background:${couleur};`
        + `color:#fff;font:700 13px/24px system-ui,sans-serif;text-align:center;`
        + `border:2px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.45)">${lettre}</div>`,
    iconSize: [26, 26], iconAnchor: [13, 13],
  });
}

function majJetons() {
  jetonDepart.classList.toggle("actif", aPoser === "depart");
  jetonArrivee.classList.toggle("actif", aPoser === "arrivee");
}

function majCoord(enregistre) {
  const d = marqueur && marqueur.getLatLng();
  const a = marqueurArrivee && marqueurArrivee.getLatLng();
  $("lat").textContent = d ? d.lat.toFixed(6) : "--";
  $("lon").textContent = d ? d.lng.toFixed(6) : "--";
  $("lat2").textContent = a ? a.lat.toFixed(6) : "--";
  $("lon2").textContent = a ? a.lng.toFixed(6) : "--";

  const manqueArrivee = caseArrivee.checked && !a;
  $("precision").textContent = !d
    ? "Clique sur la carte pour poser le départ."
    : manqueArrivee ? "Clique sur la carte pour poser l'arrivée."
    : (carte.getZoom() >= 17 ? "" : "Zoome pour affiner la position.");
  bouton.disabled = !d || manqueArrivee || enCours;

  if (enregistre) {
    ecritMemoire({
      lat: d ? d.lat : null, lon: d ? d.lng : null, zoom: carte.getZoom(),
      arrivee: a ? { lat: a.lat, lon: a.lng } : null,
      arriveeActive: caseArrivee.checked,
    });
  }
}

function poseDepart(latlng, recentre) {
  if (marqueur) marqueur.setLatLng(latlng);
  else {
    marqueur = L.marker(latlng, { draggable: true, autoPan: true,
                                  icon: icone("D", "#1f7a3d"), title: "Départ" })
                .addTo(carte);
    marqueur.on("drag move", () => majCoord(true));
  }
  if (recentre) carte.setView(latlng, Math.max(carte.getZoom(), 17));
  majCoord(true);
}

function poseArrivee(latlng, recentre) {
  if (marqueurArrivee) marqueurArrivee.setLatLng(latlng);
  else {
    marqueurArrivee = L.marker(latlng, { draggable: true, autoPan: true,
                                         icon: icone("A", "#b42318"),
                                         title: "Arrivée" }).addTo(carte);
    marqueurArrivee.on("drag move", () => majCoord(true));
  }
  if (recentre) carte.setView(latlng, Math.max(carte.getZoom(), 17));
  majCoord(true);
}

function pose(latlng, recentre) {
  if (aPoser === "arrivee" && caseArrivee.checked) poseArrivee(latlng, recentre);
  else poseDepart(latlng, recentre);
  if (caseArrivee.checked && !marqueurArrivee) aPoser = "arrivee";
  majJetons();
}

jetonDepart.onclick = () => { aPoser = "depart"; majJetons(); };
jetonArrivee.onclick = () => { aPoser = "arrivee"; majJetons(); };

caseArrivee.addEventListener("change", () => {
  blocArrivee.hidden = !caseArrivee.checked;
  if (!caseArrivee.checked) {
    if (marqueurArrivee) { carte.removeLayer(marqueurArrivee); marqueurArrivee = null; }
    aPoser = "depart";
  } else if (!marqueurArrivee) {
    aPoser = "arrivee";
  }
  majJetons();
  majCoord(true);
});

if (memoire.arriveeActive) { caseArrivee.checked = true; blocArrivee.hidden = false; }
if (departConnu) poseDepart(L.latLng(memoire.lat, memoire.lon), false);
if (caseArrivee.checked && memoire.arrivee) {
  poseArrivee(L.latLng(memoire.arrivee.lat, memoire.arrivee.lon), false);
}
aPoser = (caseArrivee.checked && !marqueurArrivee) ? "arrivee" : "depart";
majJetons();

carte.on("click", (e) => pose(e.latlng, false));
carte.on("zoomend", () => majCoord(false));

$("btn-position").onclick = () => {
  if (!navigator.geolocation) return afficheErreur("Géolocalisation indisponible.");
  navigator.geolocation.getCurrentPosition(
    (pos) => pose(L.latLng(pos.coords.latitude, pos.coords.longitude), true),
    () => afficheErreur("Position indisponible (autorisation refusée ?)."),
    { enableHighAccuracy: true });
};

// --- recherche d'adresse --------------------------------------------------
// Sur validation uniquement : la politique d'usage de Nominatim interdit les
// recherches declenchees a chaque frappe.
const champQ = $("q");
const zoneResultats = $("resultats");

async function lanceRecherche() {
  const q = champQ.value.trim();
  if (q.length < 3) return;
  zoneResultats.innerHTML = "<div>Recherche…</div>";
  try {
    const lieux = await chercheAdresse(q);
    zoneResultats.innerHTML = "";
    if (!lieux.length) { zoneResultats.innerHTML = "<div>Aucun résultat.</div>"; return; }
    lieux.slice(0, 5).forEach((lieu) => {
      const d = document.createElement("div");
      d.textContent = lieu.display_name;
      d.onclick = () => {
        pose(L.latLng(parseFloat(lieu.lat), parseFloat(lieu.lon)), true);
        zoneResultats.innerHTML = ""; champQ.value = "";
      };
      zoneResultats.appendChild(d);
    });
  } catch (e) {
    zoneResultats.innerHTML = "<div>Recherche indisponible pour l'instant. "
                            + "Pose le départ à la souris.</div>";
  }
}

$("btn-chercher").onclick = lanceRecherche;
champQ.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); lanceRecherche(); }
});

// --- reglages retenus -----------------------------------------------------
if (memoire.km) { champKm.value = memoire.km; curseur.value = memoire.km; }
if (memoire.niveau) champNiveau.value = memoire.niveau;
champKm.addEventListener("input", () => {
  curseur.value = champKm.value; ecritMemoire({ km: champKm.value });
});
curseur.addEventListener("input", () => {
  champKm.value = curseur.value; ecritMemoire({ km: curseur.value });
});
champNiveau.addEventListener("change", () => ecritMemoire({ niveau: champNiveau.value }));

$("btn-oublier").onclick = (e) => {
  e.preventDefault();
  try { localStorage.removeItem(MEMOIRE); } catch (err) { /* rien a faire */ }
  travailleur.postMessage({ type: "vide-cache" });
  message.innerHTML = '<p class="aide">Réglages et données en cache effacés. '
                    + 'Recharge la page pour repartir de zéro.</p>';
};

// --- generation -----------------------------------------------------------
function afficheErreur(texte) {
  message.innerHTML = `<p class="erreur">${texte}</p>`;
}

const travailleur = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
let debut = 0;
let minuteurAffichage = null;

travailleur.onmessage = ({ data }) => {
  if (data.type === "journal") {
    journal.textContent += (journal.textContent ? "\n" : "") + data.ligne;
    journal.scrollTop = journal.scrollHeight;
    const faits = (journal.textContent.match(/^ {2}cap /gm) || []).length;
    barre.firstElementChild.style.width = Math.min(96, 8 + (faits / 16) * 88) + "%";
    return;
  }
  if (data.type === "fini") {
    finGeneration();
    barre.firstElementChild.style.width = "100%";
    dessine(data.resultat);
    return;
  }
  if (data.type === "erreur") { finGeneration(); afficheErreur(data.message); }
};

travailleur.onerror = () => {
  finGeneration();
  afficheErreur("Le moteur de calcul n'a pas pu démarrer. Ton navigateur est "
              + "peut-être trop ancien : il faut un navigateur à jour.");
};

bouton.onclick = () => {
  if (!marqueur) return afficheErreur("Pose d'abord ton départ sur la carte.");
  const p = marqueur.getLatLng();
  const arrivee = (caseArrivee.checked && marqueurArrivee)
    ? marqueurArrivee.getLatLng() : null;
  if (caseArrivee.checked && !arrivee) return afficheErreur("Pose l'arrivée sur la carte.");
  const km = parseFloat(champKm.value);
  if (!(km > 0)) return afficheErreur("Distance invalide.");

  enCours = true;
  bouton.disabled = true;
  bouton.textContent = "Recherche en cours…";
  journal.style.display = "block"; journal.textContent = "";
  barre.style.display = "block"; barre.firstElementChild.style.width = "0";
  bilan.style.display = "none"; message.innerHTML = "";
  if (trace) { carte.removeLayer(trace); trace = null; }

  debut = Date.now();
  minuteurAffichage = setInterval(() => {
    bouton.textContent = `Recherche en cours… ${Math.round((Date.now() - debut) / 1000)} s`;
  }, 1000);

  travailleur.postMessage({
    type: "generer",
    parametres: {
      lat: p.lat, lon: p.lng, km,
      arrivee: arrivee ? [arrivee.lat, arrivee.lng] : null,
      niveau: champNiveau.value,
    },
  });
};

function finGeneration() {
  enCours = false;
  clearInterval(minuteurAffichage);
  bouton.textContent = "Générer le parcours";
  majCoord(false);
}

function telecharge(contenu, nomFichier, type) {
  const url = URL.createObjectURL(new Blob([contenu], { type }));
  const lien = document.createElement("a");
  lien.href = url; lien.download = nomFichier;
  document.body.appendChild(lien); lien.click(); lien.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function dessine(r) {
  trace = L.polyline(r.points, { color: "#e8590c", weight: 4.5, opacity: .92 })
           .addTo(carte);
  replaceMarqueurs(r);

  // Une fois le parcours trouve, c'est la carte qu'on veut voir : sur
  // telephone la feuille se replie et garde l'essentiel sous les yeux.
  const defauts = (r.doublement > 0
      ? `, ${Math.round(r.doublement)} m longeant une autre portion` : "")
    + (r.nbBouclettes > 0
      ? `, ${r.nbBouclettes} petite${r.nbBouclettes > 1 ? "s" : ""} boucle`
        + `${r.nbBouclettes > 1 ? "s" : ""}` : "");
  $("resume").textContent = `${(r.distance / 1000).toFixed(2)} km`
    + (r.repetee < 1 ? ", sans aller-retour" : `, ${Math.round(r.repetee)} m repassés`)
    + defauts;
  if (estMobile()) replie(true);

  // Cadrage apres le repli seulement : la marge a reserver n'est pas la meme
  // selon que la feuille couvre le bas de la carte ou non.
  carte.fitBounds(trace.getBounds(), margeCarte());

  const km = (m) => (m / 1000).toFixed(2) + " km";
  const pct = (m) => ` (${(m / r.longueurBoucle * 100).toFixed(0)} %)`;
  const propre = r.repetee < 1;

  let html = `<div class="titre-bloc">${r.boucle ? "Boucle" : "Parcours"} retenu</div><table>`;
  html += `<tr><td>Distance</td><td><b>${km(r.distance)}</b> `
        + `(${r.distance - r.cible >= 0 ? "+" : ""}${Math.round(r.distance - r.cible)} m)</td></tr>`;
  html += `<tr><td>Aller-retour</td><td class="${propre ? "bon" : ""}">`
        + `${propre ? "aucun" : Math.round(r.repetee) + " m"}</td></tr>`;
  html += `<tr><td>Départ à</td><td>${Math.round(r.accroche)} m du point posé</td></tr>`;
  if (r.deplaceDepart > 0 || r.deplaceArrivee > 0) {
    const quoi = r.deplaceDepart > 0 && r.deplaceArrivee > 0 ? "Les deux points ont été déplacés"
      : r.deplaceDepart > 0 ? `Le départ a été déplacé de ${Math.round(r.deplaceDepart)} m`
      : `L'arrivée a été déplacée de ${Math.round(r.deplaceArrivee)} m`;
    html += `</table><p class="avertissement">${quoi} : l'endroit posé n'est `
          + "relié à aucune rue praticable dans OpenStreetMap. Le marqueur a "
          + "suivi, pour que la carte montre le vrai départ.</p><table>";
  }
  html += `<tr><td>Portions longées</td><td class="${r.doublement > 0 ? "" : "bon"}">`
        + `${r.doublement > 0 ? Math.round(r.doublement) + " m" : "aucune"}</td></tr>`;
  html += `<tr><td>Petites boucles</td><td class="${r.nbBouclettes > 0 ? "" : "bon"}">`
        + `${r.nbBouclettes > 0
              ? `${r.nbBouclettes} (${Math.round(r.bouclettes)} m)` : "aucune"}</td></tr>`;
  html += "</table>";

  html += '<div class="titre-bloc">Relief</div>'
        + '<div id="relief"><p class="aide">Lecture du relief…</p></div>';

  html += '<div class="titre-bloc">Praticabilité vérifiée</div><table>';
  r.qualites.forEach(([q, m]) => {
    html += `<tr><td>${q}</td><td>${km(m)}${pct(m)}</td></tr>`;
  });
  html += "</table>";

  html += '<div class="titre-bloc">Type de voie</div><table>';
  r.types.forEach(([t, m]) => {
    html += `<tr><td>${t}</td><td>${km(m)}${pct(m)}</td></tr>`;
  });
  html += "</table>";

  // L'avertissement s'affiche avec le resultat, la ou il compte, et pas
  // seulement dans une page que personne n'ouvre.
  html += '<p class="avertissement">La carte peut se tromper. Vérifie le tracé '
        + 'avant de partir, respecte le code de la route et les propriétés '
        + 'privées, et regarde où tu mets les pieds.</p>';

  html += '<div class="ligne" style="margin-top:10px">'
        + '<button class="secondaire" id="btn-gpx">Télécharger le GPX</button>'
        + '<button class="secondaire" id="btn-geojson" style="flex:0 0 auto;width:auto">'
        + 'GeoJSON</button></div>';

  bilan.innerHTML = html;
  bilan.style.display = "block";

  const nomFichier = `${new Date().toISOString().slice(0, 10)}_`
                   + `${(r.distance / 1000).toFixed(1)}km`;
  $("btn-gpx").onclick = () =>
    telecharge(r.gpx, `${nomFichier}.gpx`, "application/gpx+xml");
  $("btn-geojson").onclick = () =>
    telecharge(r.geojson, `${nomFichier}.geojson`, "application/geo+json");

  afficheRelief(r);
}

/**
 * Replace les marqueurs sur le parcours rendu.
 *
 * Quand le point pose ne touche aucune rue — une adresse qui tombe au milieu
 * d'un site, une geolocalisation dans une cour — le moteur accroche le
 * parcours a la voie reliee au reste la plus proche. Laisser le marqueur ou il
 * etait ferait croire que le trace part de la : il suit donc le parcours, et
 * le bilan dit de combien.
 */
function replaceMarqueurs(r) {
  const premier = r.points[0];
  const dernier = r.points[r.points.length - 1];
  if (marqueur && r.deplaceDepart > 0) {
    marqueur.setLatLng(L.latLng(premier[0], premier[1]));
  }
  if (marqueurArrivee && caseArrivee.checked && r.deplaceArrivee > 0) {
    marqueurArrivee.setLatLng(L.latLng(dernier[0], dernier[1]));
  }
  if (r.deplaceDepart > 0 || r.deplaceArrivee > 0) majCoord(true);
}

// --- relief ---------------------------------------------------------------
// Le profil arrive apres le parcours : il demande quelques tuiles de modele
// numerique de terrain. Le trace, lui, est deja a l'ecran et n'attend pas.
let jetonRelief = 0;

async function afficheRelief(r) {
  const jeton = ++jetonRelief;
  let mesure = null;
  try {
    mesure = await profil(r.points);
  } catch (e) { mesure = null; }
  if (jeton !== jetonRelief) return;          // un autre parcours a pris la main
  const zone = $("relief");
  if (!zone) return;

  if (!mesure) {
    zone.innerHTML = '<p class="aide">Relief indisponible pour cette zone. '
                   + 'Le parcours reste valable, seul le profil manque.</p>';
    return;
  }

  const denivele = `<table><tr><td>Dénivelé positif</td>`
    + `<td><b>+${Math.round(mesure.montee)} m</b></td></tr>`
    + `<tr><td>Dénivelé négatif</td><td>−${Math.round(mesure.descente)} m</td></tr>`
    + `<tr><td>Altitude</td><td>${Math.round(mesure.mini)} à `
    + `${Math.round(mesure.maxi)} m</td></tr></table>`;

  zone.innerHTML = denivele
    + svgProfil(mesure, { titre: `Profil du parcours, ${Math.round(mesure.montee)} m `
                                 + `de dénivelé positif` })
    + '<p class="lecture" id="lecture-profil"></p>'
    + legendePentes();

  cableSurvol(zone, mesure);
}

/**
 * Survol du profil : un viseur, un point, et une ligne de lecture sous le
 * graphique. Une infobulle flottante serait rognee par un panneau de trois
 * cents pixels de large, et illisible au doigt.
 */
function cableSurvol(zone, mesure) {
  const svg = zone.querySelector("svg.profil");
  const lecture = $("lecture-profil");
  if (!svg || !lecture) return;
  const viseur = svg.querySelector(".viseur");
  const point = svg.querySelector(".point");

  const resume = () => {
    lecture.textContent = `${(mesure.longueur / 1000).toFixed(2)} km, `
      + `+${Math.round(mesure.montee)} m / −${Math.round(mesure.descente)} m`;
    viseur.setAttribute("hidden", "");
    point.setAttribute("hidden", "");
  };

  const montre = (evenement) => {
    const cadre = svg.getBoundingClientRect();
    if (!cadre.width) return;
    const x = (evenement.clientX - cadre.left) / cadre.width * 320;
    const i = indiceEn(x, mesure);
    if (i < 0) return resume();
    const [cx, cy] = positionDe(i, mesure);
    viseur.setAttribute("x1", cx); viseur.setAttribute("x2", cx);
    viseur.removeAttribute("hidden");
    point.setAttribute("cx", cx); point.setAttribute("cy", cy);
    point.removeAttribute("hidden");
    const pente = mesure.pentes[Math.min(i, mesure.pentes.length - 1)] || 0;
    lecture.textContent = `${(mesure.distances[i] / 1000).toFixed(2)} km · `
      + `${Math.round(mesure.altitudes[i])} m · `
      + `${pente >= 0 ? "+" : "−"}${Math.abs(pente).toFixed(1)} % `
      + `(${classePente(pente).libelle})`;
  };

  svg.addEventListener("pointermove", montre);
  svg.addEventListener("pointerdown", montre);
  svg.addEventListener("pointerleave", resume);
  resume();
}

majCoord(false);
