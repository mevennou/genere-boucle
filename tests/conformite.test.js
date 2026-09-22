// Conformite du site. Ces tests figent les decisions prises lors de la revue
// juridique : si quelqu'un remet un CDN ou la couche satellite dans six mois,
// la suite echoue au lieu de laisser passer.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(RACINE, "docs");
const lit = (chemin) => readFileSync(join(SITE, chemin), "utf-8");

const fichiersJS = readdirSync(join(SITE, "js")).filter((f) => f.endsWith(".js"));
const toutLeJS = fichiersJS.map((f) => lit(join("js", f))).join("\n");
const html = lit("index.html");

test("tous les modules sont syntaxiquement valides", () => {
  for (const fichier of fichiersJS) {
    execFileSync(process.execPath, ["--check", join(SITE, "js", fichier)]);
  }
  assert.ok(fichiersJS.length >= 8, `seulement ${fichiersJS.length} modules`);
});

test("aucun CDN tiers : tout est servi depuis le depot", () => {
  const interdits = ["cdnjs.cloudflare.com", "unpkg.com", "cdn.jsdelivr.net",
                     "esm.sh", "fonts.googleapis.com", "fonts.gstatic.com",
                     "ajax.googleapis.com"];
  for (const hote of interdits) {
    assert.ok(!html.includes(hote), `index.html appelle encore ${hote}`);
    assert.ok(!toutLeJS.includes(hote), `un module appelle encore ${hote}`);
  }
  assert.ok(html.includes('src="./vendor/leaflet.js"'), "Leaflet doit etre local");
  assert.ok(html.includes('href="./vendor/leaflet.css"'), "le CSS doit etre local");
  assert.ok(existsSync(join(SITE, "vendor", "leaflet.js")));
  assert.ok(existsSync(join(SITE, "vendor", "leaflet.css")));
});

test("Leaflet vendorise conserve sa mention de copyright BSD", () => {
  const leaflet = lit(join("vendor", "leaflet.js")).slice(0, 400);
  assert.ok(/Leaflet/.test(leaflet) && /\(c\)/.test(leaflet),
    "l'en-tete de copyright doit etre conserve");
});

test("pas de couche satellite sous licence commerciale", () => {
  for (const motif of ["arcgisonline", "arcgis", "Maxar", "mapbox", "google"]) {
    assert.ok(!new RegExp(motif, "i").test(toutLeJS),
      `reference a ${motif} : couche retiree lors de la revue juridique`);
  }
});

test("les seuls appels externes sont ceux qui sont declares", () => {
  // Chaque domaine appele par le site est un tiers de plus a declarer dans les
  // mentions legales. En ajouter un doit etre un geste conscient : ce test
  // echoue tant que le nouveau domaine n'est pas dans les deux listes.
  const attendus = [
    "tile.openstreetmap.org", "tile.openstreetmap.fr", "tile.opentopomap.org",
    "overpass.openstreetmap.fr", "overpass.kumi.systems", "overpass-api.de",
    "nominatim.openstreetmap.org", "s3.amazonaws.com",
    "www.openstreetmap.org", "github.com",
  ];
  // Tout ce qui ressemble a une adresse n'est pas un appel : un espace de
  // noms XML et une URL de licence sont des identifiants, ecrits dans un
  // fichier GPX ou dans un lien, jamais demandes par le navigateur.
  const identifiants = ["www.topografix.com", "www.w3.org",
                        "opendatacommons.org", "creativecommons.org"];
  const trouves = new Set();
  for (const source of [toutLeJS, html]) {
    for (const m of source.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
      const hote = m[1].toLowerCase();
      if (!identifiants.includes(hote)) trouves.add(hote);
    }
  }
  for (const hote of trouves) {
    assert.ok(attendus.includes(hote),
      `appel a ${hote} : domaine non declare. L'ajouter ici et dans les `
      + "mentions legales, ou le retirer");
  }

  // Et la page de mentions legales nomme bien chaque service appele.
  const legales = lit("mentions-legales.html");
  for (const service of ["Overpass", "Nominatim", "tuiles", "Terrarium"]) {
    assert.ok(legales.includes(service), `${service} absent des mentions legales`);
  }
});

test("le relief se lit sans confier le parcours a personne", () => {
  // Un service d'altitude recevrait la liste des points, donc le trace. Les
  // tuiles, elles, ne disent rien de ce qu'on y lit : c'est la raison du
  // choix, et elle doit le rester.
  const altitude = lit(join("js", "altitude.js"));
  assert.ok(/elevation-tiles-prod\/terrarium/.test(altitude),
    "le relief doit venir de tuiles de terrain");
  for (const service of ["open-elevation", "opentopodata", "open-meteo",
                         "googleapis", "elevation/json"]) {
    assert.ok(!toutLeJS.includes(service),
      `${service} : un service d'altitude recevrait le parcours entier`);
  }
  // Les coordonnees du parcours ne doivent jamais partir dans une URL.
  assert.ok(!/latitude=|locations=|\?.*\blat=/.test(altitude),
    "aucune coordonnee ne doit figurer dans une requete de relief");
});

test("aucun traceur ni mesure d'audience", () => {
  const mouchards = ["google-analytics", "googletagmanager", "gtag(", "plausible",
                     "matomo", "hotjar", "facebook.net", "doubleclick",
                     "sentry", "clarity.ms"];
  for (const mouchard of mouchards) {
    assert.ok(!toutLeJS.includes(mouchard) && !html.includes(mouchard),
      `traceur detecte : ${mouchard}`);
  }
  // Pas de cookie non plus : le stockage local suffit et reste exempte.
  assert.ok(!/document\.cookie/.test(toutLeJS), "aucun cookie ne doit etre pose");
});

test("le stockage local se limite aux reglages et peut etre efface", () => {
  const app = lit(join("js", "app.js"));
  assert.ok(app.includes("localStorage.removeItem"),
    "un bouton doit permettre d'effacer les reglages");
  assert.ok(html.includes("btn-oublier"), "le bouton doit exister dans la page");
  // Les cles stockees restent des reglages, pas un identifiant de visiteur.
  assert.ok(!/localStorage\.setItem\(\s*["'](?!generateur-boucle)/.test(app));
});

test("Nominatim n'est jamais appele a la frappe", () => {
  const app = lit(join("js", "app.js"));
  // La recherche doit partir d'un clic ou d'Entree, jamais d'un evenement input.
  assert.ok(!/champQ\.addEventListener\(\s*["']input["']/.test(app),
    "recherche a la frappe : interdite par la politique d'usage de Nominatim");
  assert.ok(/btn-chercher/.test(app) && /"Enter"/.test(app),
    "la recherche doit se declencher sur validation");
});

test("l'attribution cartographique est presente et jamais masquee", () => {
  const app = lit(join("js", "app.js"));
  assert.ok(app.includes("openstreetmap.org/copyright"),
    "le lien d'attribution OSM est exige par l'ODbL");
  for (const fond of ["OpenStreetMap France", "OpenTopoMap"]) {
    assert.ok(app.includes(fond), `attribution manquante : ${fond}`);
  }
  assert.ok(!/attributionControl:\s*false/.test(app),
    "le controle d'attribution ne doit pas etre desactive");
});

test("l'avertissement de securite s'affiche avec le resultat", () => {
  const app = lit(join("js", "app.js"));
  assert.ok(/avertissement/.test(app) && /dessine\(/.test(app),
    "l'avertissement doit faire partie du bilan affiche");
  const bilan = app.slice(app.indexOf("function dessine"));
  assert.ok(/class="avertissement"/.test(bilan),
    "l'avertissement doit etre dans le bloc de resultat, pas ailleurs");
  assert.ok(/Vérifie le tracé|Verifie le trace/.test(bilan));
});

test("les mentions legales sont accessibles depuis la page", () => {
  assert.ok(html.includes("mentions-legales.html"), "lien manquant en pied de page");
  assert.ok(existsSync(join(SITE, "mentions-legales.html")),
    "la page de mentions legales doit etre publiee avec le site");
  const legales = lit("mentions-legales.html");
  for (const exige of ["GitHub, Inc.", "88 Colin P. Kelly", "ODbL",
                       "mevennou", "CNIL"]) {
    assert.ok(legales.includes(exige), `mention manquante : ${exige}`);
  }

  // Aucun gabarit non rempli ne doit partir en ligne.
  for (const gabarit of ["CONTACT", "ADRESSE-DU-SITE", "À compléter",
                         "TODO", "XXX"]) {
    assert.ok(!legales.includes(gabarit),
      `gabarit non rempli dans les mentions legales : ${gabarit}`);
  }
  // Un moyen de contact doit exister et ne pas exposer d'adresse personnelle.
  assert.ok(/mailto:|\/issues/.test(legales), "aucun moyen de contact indique");
  assert.ok(!/laposte\.net|gmail\.com|@orange\.fr/i.test(legales),
    "une adresse personnelle ne doit jamais figurer sur le site");
});

test("la page reste utilisable sans JavaScript, au moins pour l'expliquer", () => {
  assert.ok(html.includes("<noscript>"), "il faut un repli sans JavaScript");
  assert.ok(html.includes("lang=\"fr\""));
  assert.ok(html.includes('name="viewport"'), "la page doit tenir sur mobile");
});

test("aucune cle d'API ni secret dans le depot", () => {
  const suspects = [/api[_-]?key\s*[:=]\s*["'][A-Za-z0-9]{8,}/i,
                    /token\s*[:=]\s*["'][A-Za-z0-9]{16,}/i,
                    /Bearer\s+[A-Za-z0-9._-]{16,}/];
  for (const motif of suspects) {
    assert.ok(!motif.test(toutLeJS), `secret potentiel : ${motif}`);
  }
});

test("les commandes de carte ne repassent pas sous le panneau", () => {
  const app = lit(join("js", "app.js"));
  // Les boutons natifs de Leaflet se placent en haut a gauche, exactement la
  // ou se trouve le panneau : ils etaient invisibles. Ils doivent rester
  // desactives au profit de #outils-carte.
  assert.ok(/zoomControl:\s*false/.test(app),
    "le controle de zoom natif doit rester desactive");
  for (const id of ["outils-carte", "zoom-plus", "zoom-moins", "recentrer"]) {
    assert.ok(html.includes(`id="${id}"`), `commande manquante : #${id}`);
  }
  for (const id of ["zoom-plus", "zoom-moins", "recentrer"]) {
    assert.ok(app.includes(`$("${id}")`), `#${id} n'est pas cable`);
  }
  assert.ok(html.includes('aria-label="Zoomer"'), "les boutons doivent etre nommes");
});

test("la mise en page mobile respecte les contraintes des telephones", () => {
  const styles = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
  const mobile = styles.slice(styles.indexOf("@media (max-width: 720px)"));
  assert.ok(/font-size:\s*16px/.test(mobile),
    "sous 16 px, iOS zoome tout seul a la saisie");
  assert.ok(/env\(safe-area-inset-bottom\)/.test(mobile),
    "la feuille basse doit degager la barre systeme");
  assert.ok(/dvh/.test(mobile), "utiliser dvh plutot que vh sur mobile");
  assert.ok(html.includes('id="poignee"'), "la feuille doit pouvoir se replier");
});

test("le worker transmet tout ce que l'interface lit du resultat", () => {
  // Defaut constate : le moteur mesurait bien les portions longees, mais le
  // worker ne les recopiait pas dans le message envoye a la page. L'interface
  // lisait donc r.doublement === undefined et n'en parlait jamais — un
  // affichage muet, qu'aucun test ne voyait puisque chaque module, pris
  // separement, faisait son travail.
  const app = lit(join("js", "app.js"));
  const worker = lit(join("js", "worker.js"));

  // Champs lus par dessine(r) dans l'interface.
  const dessine = app.slice(app.indexOf("function dessine(r)"));
  const lus = new Set([...dessine.matchAll(/\br\.(\w+)/g)].map((m) => m[1]));
  assert.ok(lus.size >= 10, `seulement ${lus.size} champs lus, extraction douteuse`);

  // Champs recopies par le worker dans le message "fini".
  const debut = worker.indexOf("resultat: {");
  assert.ok(debut > 0, "le worker doit construire un objet resultat");
  const bloc = worker.slice(debut, worker.indexOf("\n      },", debut));
  const transmis = new Set([...bloc.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]));

  for (const champ of lus) {
    assert.ok(transmis.has(champ),
      `l'interface lit r.${champ}, que le worker n'envoie pas`);
  }
});

test("le controle anti-doublement est bien branche", () => {
  const moteur = lit(join("js", "moteur.js"));
  assert.ok(moteur.includes("mesureDoublement"), "le controle geometrique doit etre appele");
  assert.ok(moteur.includes("detecteCorridors"), "les voies jumelles doivent etre regroupees");
  assert.ok(/doublement:/.test(moteur), "la mesure doit remonter dans le resultat");
  const routage = lit(join("js", "routage.js"));
  assert.ok(routage.includes("this.couloir[indexArete]"),
    "la penalite doit raisonner par couloir");
});
