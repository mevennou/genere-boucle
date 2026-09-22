#!/usr/bin/env python3
"""
Genere une boucle de course a pied d'une distance cible, depart et arrivee au
meme point, en ne passant QUE par des chemins verifies praticables.

Principe (different d'un simple appel a un serveur de routage) :

  1. On telecharge le reseau OpenStreetMap reel autour du depart (Overpass).
  2. On CONSTRUIT NOUS-MEMES le graphe pietonnier, en n'y faisant entrer que
     les voies dont les tags OSM prouvent qu'elles sont praticables. Un sentier
     broussailleux, une trace informelle, un chemin a visibilite mauvaise, un
     gue, une voie privee... n'existent tout simplement pas dans le graphe :
     il est donc IMPOSSIBLE que l'itineraire y passe. C'est une garantie
     structurelle, pas une penalite qu'une bonne distance pourrait compenser.
  3. On supprime toutes les impasses du graphe (reduction dite "2-coeur" :
     on retire iterativement les noeuds n'ayant qu'un seul voisin). Une antenne
     sans issue etant absente, le trace ne peut plus y entrer pour en ressortir
     -> plus d'aller-retour ni de demi-tour.
  4. On cherche la boucle par un polygone d'ancres (3, 4 ou 5 sommets) autour
     du depart, chaque troncon calcule en A* avec une penalite forte sur les
     aretes deja empruntees : la distance cible est atteinte en ELARGISSANT la
     boucle, jamais en ajoutant des va-et-vient.

Deux facons de s'en servir, dans ce seul fichier :

  * sans argument : une carte zoomable s'ouvre dans le navigateur par defaut
    du systeme, ou l'on pose son depart a la souris et saisit la distance.
  * avec des parametres : generation directe en ligne de commande.

Les fichiers produits sont nommes par leur date et leur distance
(2026-09-09_18h45_7.0km.gpx), donc uniques et classes chronologiquement.

Sortie : un fichier GPX standard, importable dans COROS.
Aucune dependance a installer : bibliotheque standard Python 3 uniquement.

Usage :
    python genere_boucle.py                                # la carte s'ouvre
    python genere_boucle.py --lat 48.85 --lon 2.35 --km 21.1
    python genere_boucle.py --lat 48.85 --lon 2.35 --km 10 --niveau strict
    python genere_boucle.py --lat 48.85 --lon 2.35 --km 10 --niveau tolerant
"""

import argparse
import hashlib
import heapq
import http.server
import json
import math
import os
import queue
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import webbrowser

# ---------------------------------------------------------------------------
# Aucun point de depart n'est ecrit dans ce fichier : il est pose sur la carte
# (le navigateur retient le dernier utilise, sur ce poste uniquement) ou passe
# en --lat / --lon. Le script peut donc etre partage tel quel sans divulguer
# la moindre adresse.
# ---------------------------------------------------------------------------
DEFAUT_KM = 7

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(SCRIPT_DIR, ".cache_osm")

RAYON_TERRE = 6371008.8

# Serveurs Overpass publics et partages : l'un peut etre sature quand les
# autres repondent tout de suite. On ne les interroge pas tous d'emblee (ce
# serait tripler la charge d'un service benevole) : on en sollicite un de plus
# seulement si le precedent tarde, d'un delai proportionne a la zone demandee.
# Trois serveurs reellement distincts, du plus rapide au plus lent d'apres
# les mesures. Celui du chapitre francais d'OpenStreetMap est le plus prompt
# ici et couvre pourtant la planete entiere (verifie hors de France).
# overpass.private.coffee a ete retire : meme machine que kumi.systems, donc
# aucune redondance reelle.
MIROIRS_OVERPASS = (
    "https://overpass.openstreetmap.fr/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass-api.de/api/interpreter",
)
PERIODE_ATTENTE = 15     # s entre deux messages "toujours en attente"

# ---------------------------------------------------------------------------
# Regles de praticabilite
# ---------------------------------------------------------------------------

# Jamais dans le graphe, quel que soit le niveau : voies rapides, axes sans
# trottoir garanti, chantiers, quais, ascenseurs, couloirs interieurs...
HW_INTERDITS = {
    "motorway", "motorway_link", "trunk", "trunk_link",
    "primary", "primary_link", "construction", "proposed", "planned",
    "raceway", "bus_guideway", "busway", "escape", "corridor", "elevator",
    "platform", "rest_area", "services", "emergency_bay", "via_ferrata",
}

# Cout de base par type de voie (1.0 = ideal pour courir).
# Le cout ne sert qu'a PREFERER ; tout ce qui est present est praticable.
COUT_BASE = {
    "footway": 1.00,
    "pedestrian": 1.00,
    "cycleway": 1.05,
    "path": 1.10,
    "living_street": 1.10,
    "residential": 1.15,
    "unclassified": 1.20,
    "track": 1.25,
    "service": 1.35,
    "road": 1.60,
    "bridleway": 1.70,
    "tertiary": 1.90,
    "tertiary_link": 1.90,
    "secondary": 3.20,
    "secondary_link": 3.20,
    "steps": 4.00,
}

SURFACES_DURES = {
    "asphalt", "paved", "concrete", "concrete:plates", "concrete:lanes",
    "paving_stones", "sett", "cobblestone", "unhewn_cobblestone", "chipseal",
    "metal", "wood", "compacted", "fine_gravel", "gravel", "pebblestone",
    "rock", "bricks", "grass_paver",
}
SURFACES_MEUBLES = {
    "ground", "dirt", "earth", "unpaved", "shells",
}
# Revetements qui deviennent boueux, glissants ou envahis : ecartes sauf en
# niveau tolerant. C'est le cas typique du "chemin qui n'en est plus un".
SURFACES_RISQUEES = {
    "grass", "woodchips", "clay", "soil", "sand", "dirt/sand",
}
SURFACES_INTERDITES = {
    "mud", "sand", "snow", "ice", "salt", "water", "fine_sand",
}

# Voies de desserte a l'usage des riverains ou des vehicules de service : on
# n'a rien a y faire a pied, et c'est ce qui fait passer "derriere" les
# batiments. Acceptees seulement au niveau tolerant.
SERVICES_PRIVES = {
    "driveway", "parking_aisle", "drive-through", "emergency_access",
    "slipway", "bus", "busway",
}

# Ce qui barre un chemin sans etre une barriere : le tag obstacle decrit un
# encombrement releve sur la voie. En sous-bois, c'est exactement le cas dont
# on se mefie — un arbre en travers, un roncier, un eboulis.
OBSTACLES_BLOQUANTS = {
    "vegetation", "log", "fallen_tree", "tree", "rockfall", "landslide",
    "boulder", "debris",
}

# Obstacles qu'on ne franchit pas a pied, meme sans tag d'acces. Les autres
# (borne, barriere basculante, chicane, echalier...) se contournent ou
# s'enjambent : ils ne coupent pas le chemin.
BARRIERES_INFRANCHISSABLES = {
    "wall", "fence", "hedge", "retaining_wall", "city_wall", "ditch",
    "jersey_barrier", "full-height_turnstile", "sally_port", "spikes",
    "hampshire_gate", "guard_rail",
}


def _nombre(valeur):
    """Convertit '1.5', '1,5 m', '2' en flottant ; None si impossible."""
    if valeur is None:
        return None
    try:
        return float(str(valeur).split()[0].replace(",", "."))
    except (ValueError, IndexError):
        return None


def evalue_voie(tags, niveau, balise=False):
    """Renvoie (cout, etiquette) si la voie est praticable, sinon None.

    `balise` indique que la voie appartient a un itineraire de randonnee
    officiel (GR, PR...) : c'est la meilleure preuve d'entretien disponible
    dans OpenStreetMap.

    Renvoyer None = la voie n'entrera pas dans le graphe, donc l'itineraire ne
    pourra jamais l'emprunter. C'est ici que se joue la praticabilite.
    """
    hw = tags.get("highway")
    if not hw or hw in HW_INTERDITS or hw not in COUT_BASE:
        return None
    if tags.get("area") == "yes":
        return None                       # esplanade cartographiee en surface

    # --- interdictions d'acces --------------------------------------------
    if tags.get("indoor") == "yes" or tags.get("level") is not None:
        return None                       # circulation interieure a un batiment

    pied = tags.get("foot")
    if pied in ("no", "private", "destination"):
        return None                       # "destination" : on ne fait que passer
    autorise_explicitement = pied in ("yes", "designated", "permissive", "official")
    if not autorise_explicitement:
        acces = tags.get("access")
        if acces in ("no", "private", "customers", "permit", "military",
                     "delivery", "agricultural", "forestry"):
            return None

    # Desserte privee : allee de parking, acces de maison, rampe de mise a
    # l'eau... On y passe physiquement, mais on n'a rien a y faire : c'est la
    # cause des passages derriere les batiments. Un cheminement pieton
    # explicitement amenage sur ces voies reste evidemment autorise.
    service = tags.get("service")
    if (service in SERVICES_PRIVES and niveau != "tolerant"
            and pied not in ("yes", "designated", "official")):
        return None

    # --- obstacles physiques et etat du terrain ---------------------------
    if tags.get("ford") not in (None, "no"):
        return None                       # traversee de cours d'eau a gue
    if tags.get("overgrown") == "yes":
        return None                       # envahi par la vegetation
    if tags.get("seasonal") not in (None, "no"):
        return None                       # praticable seulement une partie de l'annee
    if tags.get("flooded") == "yes":
        return None
    if tags.get("informal") == "yes":
        return None                       # trace sauvage, non entretenue
    if tags.get("abandoned") == "yes" or tags.get("disused") == "yes":
        return None
    if tags.get("obstacle") in OBSTACLES_BLOQUANTS:
        return None                       # arbre en travers, vegetation, eboulis

    visibilite = tags.get("trail_visibility")
    mauvaise_visibilite = {"bad", "horrible", "no"}
    if niveau == "strict":
        mauvaise_visibilite = mauvaise_visibilite | {"intermediate"}
    if visibilite in mauvaise_visibilite:
        return None                       # on perd le chemin en le suivant

    sac = tags.get("sac_scale")
    if sac not in (None, "hiking"):
        return None                       # randonnee de montagne, pas de la course

    lissage = tags.get("smoothness")
    if lissage in ("horrible", "very_horrible", "impassable"):
        return None
    if niveau == "strict" and lissage in ("bad", "very_bad"):
        return None
    if niveau != "tolerant" and lissage == "very_bad" \
            and hw in ("path", "track", "bridleway"):
        return None                       # ornieres et racines en sous-bois

    tracktype = tags.get("tracktype")
    if tracktype in ("grade4", "grade5"):
        return None                       # terre meuble / herbe, souvent boueux

    largeur = _nombre(tags.get("width") or tags.get("est_width"))
    if largeur is not None and largeur < 0.6:
        return None                       # passage trop etroit

    surface = tags.get("surface")
    if surface in SURFACES_INTERDITES:
        return None

    # --- qualite du revetement --------------------------------------------
    if surface in SURFACES_RISQUEES and niveau != "tolerant":
        return None                       # herbe, terre grasse : boueux l'hiver

    if surface in SURFACES_DURES or tracktype in ("grade1", "grade2"):
        qualite = "dure"
    elif surface in SURFACES_MEUBLES or surface in SURFACES_RISQUEES:
        qualite = "meuble"
    else:
        qualite = "inconnue"

    # Un sentier ou chemin rural sans revetement dur est la premiere source de
    # mauvaises surprises : en sous-bois, un arbre tombe ou un roncier suffit a
    # le rendre impraticable, et la carte n'en sait rien. On ne l'accepte donc
    # au niveau normal que s'il porte une preuve d'entretien : un nom (venelle,
    # sentier communal), une appartenance a un itineraire balise, un eclairage
    # public, une visibilite ou un etat renseignes. La terre battue seule n'est
    # pas une preuve : c'est le defaut de tous les sentiers oublies.
    naturel = hw in ("path", "track", "bridleway")
    if naturel:
        if niveau == "strict" and qualite != "dure":
            return None
        if qualite != "dure" and niveau == "normal":
            documente = bool(tags.get("name")) or balise \
                or tags.get("lit") not in (None, "no") \
                or visibilite in ("excellent", "good") \
                or tags.get("bicycle") in ("designated", "yes") \
                or lissage in ("excellent", "good", "intermediate")
            if not documente:
                return None

    cout = COUT_BASE[hw]
    if qualite == "meuble":
        cout *= 1.15
    elif qualite == "inconnue":
        cout *= 1.45 if naturel else 1.00
    if visibilite in ("excellent", "good"):
        cout *= 0.90                      # chemin balise, on le favorise
    if tags.get("name") and naturel:
        cout *= 0.95                      # chemin nomme = chemin entretenu
    if balise:
        cout *= 0.85                      # itineraire de randonnee entretenu

    if service in SERVICES_PRIVES:
        cout *= 2.0                       # tolere seulement au niveau tolerant
    elif service == "alley":
        cout *= 1.3

    if hw in ("secondary", "secondary_link", "tertiary", "tertiary_link"):
        if tags.get("sidewalk") in ("no", "none"):
            cout *= 1.8
        vitesse = _nombre(tags.get("maxspeed"))
        if vitesse is not None and vitesse >= 70:
            cout *= 1.6

    if not naturel and qualite == "inconnue":
        qualite = "voirie"                # trottoir, rue : revetement implicite
    return cout, hw, ("balise" if balise else qualite)


# ---------------------------------------------------------------------------
# Geometrie
# ---------------------------------------------------------------------------
def cap_entre(lat1, lon1, lat2, lon2):
    """Cap initial en degres pour aller du premier point au second."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dlambda = math.radians(lon2 - lon1)
    y = math.sin(dlambda) * math.cos(phi2)
    x = (math.cos(phi1) * math.sin(phi2)
         - math.sin(phi1) * math.cos(phi2) * math.cos(dlambda))
    return math.degrees(math.atan2(y, x)) % 360.0


def distance_haversine(lat1, lon1, lat2, lon2):
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = (math.sin(dphi / 2) ** 2
         + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2)
    return 2 * RAYON_TERRE * math.asin(math.sqrt(a))


def point_a_distance(lat, lon, cap_deg, distance_m):
    d = distance_m / RAYON_TERRE
    cap = math.radians(cap_deg)
    lat1, lon1 = math.radians(lat), math.radians(lon)
    lat2 = math.asin(math.sin(lat1) * math.cos(d)
                     + math.cos(lat1) * math.sin(d) * math.cos(cap))
    lon2 = lon1 + math.atan2(math.sin(cap) * math.sin(d) * math.cos(lat1),
                             math.cos(d) - math.sin(lat1) * math.sin(lat2))
    return math.degrees(lat2), (math.degrees(lon2) + 540) % 360 - 180


# ---------------------------------------------------------------------------
# Telechargement du reseau
# ---------------------------------------------------------------------------
class DonneesIndisponibles(Exception):
    """OpenStreetMap est injoignable : on refuse de produire un trace non verifie."""


def interroge_overpass(requete, nom_cache, rafraichir, libelle, journal=print,
                       delai_miroir=25.0, delai_abandon=240.0,
                       exige_elements=False):
    """Appel Overpass avec cache disque et course entre les miroirs.

    Le premier serveur qui repond gagne ; les autres ne sont sollicites que
    s'il tarde. Evite d'attendre plusieurs minutes derriere un seul serveur
    sature, sans pour autant les surcharger tous les trois systematiquement.
    """
    empreinte = hashlib.md5((nom_cache + requete).encode()).hexdigest()[:12]
    cache = os.path.join(CACHE_DIR, "{}_{}.json".format(nom_cache, empreinte))

    if not rafraichir and os.path.exists(cache):
        with open(cache, encoding="utf-8") as fichier:
            donnees = json.load(fichier)
        journal("  {} : relu du cache ({} elements)".format(libelle, len(donnees)))
        return donnees

    corps = urllib.parse.urlencode({"data": requete}).encode("utf-8")
    reponses = queue.Queue()

    def tente(miroir):
        try:
            demande = urllib.request.Request(miroir, data=corps, headers={
                "User-Agent": "generateur-boucle-gpx/2.0 (usage personnel)"})
            with urllib.request.urlopen(demande, timeout=delai_abandon) as reponse:
                reponses.put((miroir, json.loads(reponse.read().decode("utf-8"))))
        except (urllib.error.URLError, OSError, ValueError) as erreur:
            reponses.put((miroir, erreur))

    def hote(miroir):
        return miroir.split("/")[2]

    debut = time.monotonic()
    lances, termines = 0, 0
    dernier_lancement = 0.0
    dernier_message = debut
    echecs = []

    while True:
        maintenant = time.monotonic()

        # Un miroir de plus : tout de suite pour le premier, puis seulement
        # si aucun des precedents n'a repondu dans le delai imparti.
        if (lances < len(MIROIRS_OVERPASS)
                and (lances == 0 or maintenant - dernier_lancement >= delai_miroir)):
            miroir = MIROIRS_OVERPASS[lances]
            journal("  {} : interrogation de {}".format(libelle, hote(miroir)))
            threading.Thread(target=tente, args=(miroir,), daemon=True).start()
            lances += 1
            dernier_lancement = maintenant

        try:
            miroir, resultat = reponses.get(timeout=1.0)
        except queue.Empty:
            if maintenant - dernier_message >= PERIODE_ATTENTE:
                journal("  {} : toujours en attente ({:.0f} s)"
                        .format(libelle, maintenant - debut))
                dernier_message = maintenant
            if maintenant - debut > delai_abandon:
                break
            continue

        termines += 1
        if isinstance(resultat, Exception):
            echecs.append("{} : {}".format(hote(miroir), resultat))
            journal("    {} indisponible ({})".format(hote(miroir), resultat))
            if termines >= len(MIROIRS_OVERPASS):
                break
            continue

        elements = resultat.get("elements", [])
        if exige_elements and not elements:
            # Certains serveurs ne couvrent qu'une region : ils repondent
            # "rien trouve" au lieu d'une erreur. On passe au suivant.
            echecs.append("{} : aucune donnee pour cette zone".format(hote(miroir)))
            journal("    {} ne couvre pas cette zone".format(hote(miroir)))
            if termines >= len(MIROIRS_OVERPASS):
                break
            continue
        try:
            os.makedirs(CACHE_DIR, exist_ok=True)
            with open(cache, "w", encoding="utf-8") as fichier:
                json.dump(elements, fichier)
        except OSError:
            pass                        # sans cache, on continue quand meme
        journal("  {} : {} elements recus de {} en {:.0f} s"
                .format(libelle, len(elements), hote(miroir),
                        time.monotonic() - debut))
        return elements

    raise DonneesIndisponibles(
        "Impossible de recuperer les donnees OpenStreetMap ({}). "
        "La praticabilite ne peut pas etre verifiee sans elles : aucun trace "
        "ne sera genere plutot qu'un trace non verifie. Reessayer dans une "
        "minute.".format("; ".join(echecs) or "delai depasse"))


def boite_englobante(lat, lon, rayon_m):
    """Coordonnees (sud, ouest, nord, est) du carre contenant le disque.

    Overpass repond bien plus vite sur une boite que sur un filtre "around",
    qui calcule une distance pour chaque candidat : sur un rayon de 3 km, la
    version "around" expire la ou la boite repond en une vingtaine de
    secondes. Le carre couvre un peu plus de terrain que le disque, ce qui ne
    gene pas : c'est autant de reseau utilisable en plus.
    """
    degre_lat = rayon_m / 111320.0
    degre_lon = rayon_m / (111320.0 * max(math.cos(math.radians(lat)), 0.01))
    return "{:.6f},{:.6f},{:.6f},{:.6f}".format(
        lat - degre_lat, lon - degre_lon, lat + degre_lat, lon + degre_lon)


def telecharge_reseau(lat, lon, rayon_m, rafraichir, journal=print):
    """Toutes les voies OSM susceptibles d'etre parcourues a pied.

    Le tri des types de voies est fait ensuite, en Python : demander a
    Overpass d'exclure lui-meme les voies rapides (par expression reguliere)
    lui coutait assez cher pour provoquer des erreurs 504.
    """
    requete = (
        '[out:json][timeout:300];'
        'way({})["highway"];'
        'out geom;'
    ).format(boite_englobante(lat, lon, rayon_m))
    # Plus la zone est vaste, plus il faut laisser de temps au serveur avant
    # d'en solliciter un deuxieme : ce sont des machines benevoles.
    elements = interroge_overpass(
        requete, "reseau", rafraichir, "reseau", journal,
        delai_miroir=20.0 + rayon_m / 200.0,
        delai_abandon=120.0 + rayon_m / 25.0,
        exige_elements=True)
    voies = [e for e in elements if e.get("type") == "way"]
    if not voies:
        raise DonneesIndisponibles("Aucune voie trouvee autour de ce point.")
    return voies


def telecharge_itineraires(lat, lon, rayon_m, rafraichir, journal=print):
    """Identifiants des voies appartenant a un itineraire pedestre officiel
    (GR, PR, sentier cotier...). C'est la meilleure garantie d'entretien
    disponible dans OpenStreetMap : ces chemins sont balises et debroussailles."""
    requete = (
        '[out:json][timeout:300];'
        'rel({})["route"~"^(hiking|foot|walking|running)$"];'
        'out body;'
    ).format(boite_englobante(lat, lon, rayon_m))
    elements = interroge_overpass(
        requete, "itineraires", rafraichir, "itineraires balises", journal,
        delai_miroir=20.0 + rayon_m / 200.0,
        delai_abandon=120.0 + rayon_m / 25.0)
    balises = set()
    for element in elements:
        if element.get("type") != "relation":
            continue
        for membre in element.get("members", ()):
            if membre.get("type") == "way":
                balises.add(membre.get("ref"))
    return balises


# ---------------------------------------------------------------------------
# Construction du graphe praticable
# ---------------------------------------------------------------------------
def telecharge_barrieres(lat, lon, rayon_m, rafraichir, journal=print):
    """Noeuds portant un obstacle (portail, cloture, chicane...) autour du
    depart. Seuls les tags sont utiles : l'identifiant suffit a retrouver le
    point dans le graphe."""
    requete = ('[out:json][timeout:180];'
               'node(around:{:.0f},{:.6f},{:.6f})["barrier"];'
               'out tags;').format(rayon_m, lat, lon)
    return interroge_overpass(requete, "barrieres", rafraichir,
                              "barrieres", journal)


def noeuds_infranchissables(elements):
    """Identifiants des noeuds qu'on ne peut pas franchir a pied.

    Un chemin qui traverse un portail verrouille ou une cloture n'est pas
    praticable au-dela : on coupe le graphe a cet endroit plutot que d'y faire
    passer le trace.
    """
    bloques = set()
    for element in elements:
        if element.get("type") != "node":
            continue
        tags = element.get("tags") or {}
        barriere = tags.get("barrier")
        if not barriere:
            continue
        pied = tags.get("foot")
        if pied in ("yes", "designated", "permissive", "official"):
            continue                      # passage explicitement autorise
        if pied in ("no", "private"):
            bloques.add(element["id"])
            continue
        if tags.get("locked") == "yes":
            bloques.add(element["id"])
            continue
        if tags.get("access") in ("no", "private", "customers", "permit",
                                  "military", "delivery"):
            bloques.add(element["id"])
            continue
        if barriere in BARRIERES_INFRANCHISSABLES:
            bloques.add(element["id"])
    return bloques


def construit_graphe_brut(voies, niveau, balises, bloques=()):
    """Graphe noeud-a-noeud limite aux voies jugees praticables."""
    coords = {}
    brut = {}
    retenues = 0
    for voie in voies:
        tags = voie.get("tags") or {}
        verdict = evalue_voie(tags, niveau, voie.get("id") in balises)
        if verdict is None:
            continue
        cout, etiquette, qualite = verdict
        geometrie = voie.get("geometry") or []
        noeuds = voie.get("nodes") or []
        if len(noeuds) != len(geometrie) or len(noeuds) < 2:
            continue
        retenues += 1
        for point, identifiant in zip(geometrie, noeuds):
            coords[identifiant] = (point["lat"], point["lon"])
        for a, b in zip(noeuds, noeuds[1:]):
            if a == b or a in bloques or b in bloques:
                continue                  # portail ferme, cloture : on coupe
            lat1, lon1 = coords[a]
            lat2, lon2 = coords[b]
            longueur = distance_haversine(lat1, lon1, lat2, lon2)
            if longueur <= 0:
                continue
            brut.setdefault(a, []).append((b, longueur, cout, etiquette, qualite))
            brut.setdefault(b, []).append((a, longueur, cout, etiquette, qualite))
    return coords, brut, retenues


def contracte(brut, coords, proteges):
    """Fusionne les chaines de noeuds de degre 2 en aretes uniques.

    Le graphe devient 5 a 10 fois plus petit : les recherches d'itineraire
    sont d'autant plus rapides, sans rien perdre de la geometrie (la
    polyligne complete est conservee dans l'arete).
    """
    jonctions = {n for n, voisins in brut.items() if len(voisins) != 2}
    jonctions |= set(proteges)

    aretes = []          # (u, v, longueur, cout, polyligne, etiquette, qualite)
    adjacence = {}
    vues = set()         # demi-aretes deja parcourues : (noeud, index)

    def marque_retour(noeud, precedent):
        for indice, (voisin, _, _, _, _) in enumerate(brut[noeud]):
            if voisin == precedent and (noeud, indice) not in vues:
                vues.add((noeud, indice))
                return

    for depart in jonctions:
        for indice, (voisin, longueur, cout, etiquette, qualite) in enumerate(brut[depart]):
            if (depart, indice) in vues:
                continue
            vues.add((depart, indice))

            polyligne = [depart]
            total_longueur = 0.0
            total_cout = 0.0
            precedent, courant = depart, voisin
            long_courante, cout_courant = longueur, cout
            garde = 0

            while True:
                garde += 1
                if garde > 100000:
                    break
                total_longueur += long_courante
                total_cout += long_courante * cout_courant
                polyligne.append(courant)
                marque_retour(courant, precedent)
                if courant in jonctions:
                    break
                suite = [t for t in brut[courant] if t[0] != precedent]
                if not suite:
                    break
                precedent, (courant, long_courante, cout_courant, _, _) = courant, suite[0]

            if len(polyligne) < 2 or total_longueur <= 0:
                continue
            index = len(aretes)
            aretes.append((polyligne[0], polyligne[-1], total_longueur,
                           total_cout, polyligne, etiquette, qualite))
            adjacence.setdefault(polyligne[0], []).append((polyligne[-1], index))
            adjacence.setdefault(polyligne[-1], []).append((polyligne[0], index))

    return aretes, adjacence


def supprime_impasses(aretes, adjacence):
    """Reduction 2-coeur : retire iterativement tout noeud a un seul voisin.

    Consequence directe : plus aucune antenne sans issue dans le graphe. Le
    trace ne peut donc plus y entrer et faire demi-tour.
    """
    degre = {n: len(v) for n, v in adjacence.items()}
    actives = set(range(len(aretes)))
    pile = [n for n, d in degre.items() if d <= 1]
    supprimes = set()

    while pile:
        noeud = pile.pop()
        if noeud in supprimes or degre.get(noeud, 0) > 1:
            continue
        supprimes.add(noeud)
        for voisin, index in adjacence.get(noeud, ()):
            if index not in actives:
                continue
            actives.discard(index)
            if voisin != noeud:
                degre[voisin] = degre.get(voisin, 1) - 1
                if degre[voisin] <= 1 and voisin not in supprimes:
                    pile.append(voisin)
        degre[noeud] = 0

    reduite = {}
    for index in actives:
        u, v = aretes[index][0], aretes[index][1]
        reduite.setdefault(u, []).append((v, index))
        reduite.setdefault(v, []).append((u, index))
    return reduite


def composante(adjacence, source):
    """Noeuds atteignables depuis source (parcours en largeur)."""
    vus = {source}
    pile = [source]
    while pile:
        noeud = pile.pop()
        for voisin, _ in adjacence.get(noeud, ()):
            if voisin not in vus:
                vus.add(voisin)
                pile.append(voisin)
    return vus


# ---------------------------------------------------------------------------
# Index spatial et recherche d'itineraire
# ---------------------------------------------------------------------------
class IndexSpatial:
    """Grille simple pour trouver le noeud le plus proche d'une coordonnee."""

    PAS = 0.002      # ~200 m

    def __init__(self, coords, noeuds):
        self.coords = coords
        self.cases = {}
        for noeud in noeuds:
            lat, lon = coords[noeud]
            self.cases.setdefault(self._cle(lat, lon), []).append(noeud)

    def _cle(self, lat, lon):
        return (int(math.floor(lat / self.PAS)), int(math.floor(lon / self.PAS)))

    def plus_proche(self, lat, lon, rayon_max=1500.0):
        base_i, base_j = self._cle(lat, lon)
        meilleur, meilleure_distance = None, rayon_max
        anneau = 0
        while anneau <= 12:
            candidats = []
            for i in range(base_i - anneau, base_i + anneau + 1):
                for j in range(base_j - anneau, base_j + anneau + 1):
                    if anneau and max(abs(i - base_i), abs(j - base_j)) != anneau:
                        continue
                    candidats.extend(self.cases.get((i, j), ()))
            for noeud in candidats:
                nlat, nlon = self.coords[noeud]
                d = distance_haversine(lat, lon, nlat, nlon)
                if d < meilleure_distance:
                    meilleur, meilleure_distance = noeud, d
            if meilleur is not None and anneau >= 1:
                break
            anneau += 1
        return meilleur, meilleure_distance


def rejoint_coeur(adjacence, aretes, source, coeur):
    """Chemin le plus court du depart vers le premier noeud du reseau maille.

    On explore le reseau plutot que de viser le noeud le plus proche a vol
    d'oiseau : le voisin d'en face peut n'etre accessible qu'en contournant
    un pate de maisons.
    """
    if source in coeur:
        return source, []
    couts = {source: 0.0}
    parents = {}
    tas = [(0.0, source)]
    vus = set()
    while tas:
        cout, noeud = heapq.heappop(tas)
        if noeud in vus:
            continue
        vus.add(noeud)
        if noeud in coeur:
            trajet = []
            courant = noeud
            while courant != source:
                precedent, index = parents[courant]
                trajet.append((index, precedent))
                courant = precedent
            trajet.reverse()
            return noeud, trajet
        for voisin, index in adjacence.get(noeud, ()):
            nouveau = cout + aretes[index][3]
            if nouveau < couts.get(voisin, float("inf")):
                couts[voisin] = nouveau
                parents[voisin] = (noeud, index)
                heapq.heappush(tas, (nouveau, voisin))
    return None, None


def plus_court_chemin(adjacence, aretes, coords, source, but, penalites=None,
                      penalite=12.0, couloirs=None):
    """A* de source vers but.

    Les couloirs de `penalites` sont payes `penalite` fois plus cher : c'est ce
    qui interdit en pratique les allers-retours. Le cote droit de la chaussee
    est legerement rencheri, la ou les deux bords sont cartographies a part.
    """
    if source == but:
        return 0.0, []
    penalites = penalites or ()
    lat_but, lon_but = coords[but]

    def heuristique(noeud):
        lat, lon = coords[noeud]
        return distance_haversine(lat, lon, lat_but, lon_but)

    couts = {source: 0.0}
    parents = {}
    tas = [(heuristique(source), 0.0, source)]
    vus = set()

    while tas:
        _, cout, noeud = heapq.heappop(tas)
        if noeud in vus:
            continue
        vus.add(noeud)
        if noeud == but:
            break
        for voisin, index in adjacence.get(noeud, ()):
            if voisin in vus:
                continue
            poids = aretes[index][3]
            if (couloirs.couloir[index] if couloirs else index) in penalites:
                poids *= penalite
            if couloirs is not None:
                poids *= couloirs.surcout(index, noeud, aretes)
            nouveau = cout + poids
            if nouveau < couts.get(voisin, float("inf")):
                couts[voisin] = nouveau
                parents[voisin] = (noeud, index)
                heapq.heappush(tas, (nouveau + heuristique(voisin), nouveau, voisin))

    if but not in parents and but != source:
        return None

    trajet = []
    courant = but
    while courant != source:
        precedent, index = parents[courant]
        trajet.append((index, precedent))
        courant = precedent
    trajet.reverse()
    return couts[but], trajet


# ---------------------------------------------------------------------------
# Recherche de la boucle
# ---------------------------------------------------------------------------
def longueur_trajet(trajet, aretes):
    return sum(aretes[index][2] for index, _ in trajet)


# Ce qui separe un lacet de la forme meme du parcours : au-dela d'un quart de
# la distance visee, la boucle n'est plus un crochet a supprimer mais une part
# du dessin. C'est la borne que retient aussi mesure_bouclettes, et il faut
# l'appliquer a tout effacement : effacer les lacets d'une marche fermee sans
# borne la reduirait a rien, puisqu'une boucle est, par construction, une
# marche qui revient sur elle-meme.
PART_LACET = 0.25


def efface_boucles(trajet, aretes, coords, depart, ferme, cible_m, seuil=25.0):
    """Efface les boucles du parcours : effacement de lacets sur la marche.

    Un parcours qui repasse par un noeud deja visite contient, entre les deux
    passages, une boucle fermee — le crochet qui fait le tour d'un pate de
    maisons et revient au meme carrefour. La retirer laisse une marche valide
    entre les memes extremites, simplement plus courte : la dichotomie sur le
    rayon rattrape la distance en elargissant, ce qui est precisement la facon
    dont ce programme veut allonger un parcours.

    Une boucle peut aussi se refermer a quelques metres sans repasser par le
    meme noeud, quand l'aller et le retour empruntent deux voies voisines : on
    la coupe aussi, mais seulement si elle a la taille d'un lacet.

    La fermeture d'une boucle est le but recherche, pas un lacet : le dernier
    retour au depart est donc epargne.
    """
    lacet_max = cible_m * PART_LACET
    pile = []
    cumul = [0.0]
    position = {depart: 0}
    atteints = {0: depart}
    case = max(10.0, seuil)
    cases = {}

    def case_de(noeud):
        lat, lon = coords[noeud]
        return (math.floor(lat * 111320 / case),
                math.floor(lon * 111320 * math.cos(math.radians(lat)) / case))

    def enregistre(noeud, rang):
        position[noeud] = rang
        atteints[rang] = noeud
        cases.setdefault(case_de(noeud), []).append(rang)

    def oublie(rang):
        for noeud in [n for n, p in position.items() if p > rang]:
            del position[noeud]
        for liste in cases.values():
            liste[:] = [p for p in liste if p <= rang]
        del pile[rang:]
        del cumul[rang + 1:]

    enregistre(depart, 0)

    for k, (index, depuis) in enumerate(trajet):
        arete = aretes[index]
        vers = arete[1] if depuis == arete[0] else arete[0]
        pile.append(trajet[k])
        cumul.append(cumul[-1] + arete[2])
        if ferme and k == len(trajet) - 1:
            break

        def lacet(rang):
            # Le depart est le seul point qu'une boucle a le droit de revoir :
            # y revenir en cours de route n'autorise pas a jeter tout ce qui
            # precede, sans quoi il ne resterait rien.
            if ferme and rang == 0:
                return False
            parcouru = cumul[-1] - cumul[rang]
            return 60.0 <= parcouru <= lacet_max

        # Retour exact sur un noeud deja visite : la boucle est sans ambiguite.
        if vers in position:
            if lacet(position[vers]):
                oublie(position[vers])
            else:
                enregistre(vers, len(pile))
            continue

        # Sinon, retour a quelques metres d'un point deja atteint : l'aller et
        # le retour ont emprunte deux voies voisines sans partager de noeud.
        ci, cj = case_de(vers)
        candidat = -1
        vlat, vlon = coords[vers]
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for rang in cases.get((ci + di, cj + dj), ()):
                    if rang <= candidat or not lacet(rang):
                        continue
                    alat, alon = coords[atteints[rang]]
                    if distance_haversine(vlat, vlon, alat, alon) > seuil:
                        continue
                    candidat = rang
        if candidat >= 0:
            oublie(candidat)
            continue

        enregistre(vers, len(pile))
    return pile


def _assemble(adjacence, aretes, coords, etapes, couloirs, cible_m):
    """Enchaine les troncons en penalisant les couloirs deja empruntes.

    Renvoie (longueur, repetee, trajet) ou None. La repetition se compte par
    couloir et non par arete : aller par la rue et revenir par le trottoir
    d'a cote est un doublement, meme si ce sont deux aretes differentes. Un
    seul passage reste du au couloir, le reste est compte comme repete ; sans
    jumelle, la formule redonne exactement longueur x (n - 1), comme avant.
    """
    penalises = set()
    trajet_brut = []
    for a, b in zip(etapes, etapes[1:]):
        if a == b:
            continue
        resultat = plus_court_chemin(adjacence, aretes, coords, a, b,
                                     penalites=penalises, couloirs=couloirs)
        if resultat is None:
            return None
        _, trajet = resultat
        for index, _ in trajet:
            penalises.add(couloirs.couloir[index] if couloirs else index)
        trajet_brut.extend(trajet)

    ferme = etapes[0] == etapes[-1]
    trajet_total = efface_boucles(trajet_brut, aretes, coords, etapes[0], ferme,
                                  cible_m)
    if not trajet_total:
        return None

    # Les comptes se refont sur le trajet net : ce qui a ete efface n'a pas
    # ete parcouru, et ne doit compter ni comme repetition ni comme longueur.
    utilisees = {}
    for index, _ in trajet_total:
        utilisees[index] = utilisees.get(index, 0) + 1
    longueur = longueur_trajet(trajet_total, aretes)

    par_couloir = {}
    for index, n in utilisees.items():
        c = couloirs.couloir[index] if couloirs else index
        total, plus_long = par_couloir.get(c, (0.0, 0.0))
        par_couloir[c] = (total + aretes[index][2] * n,
                          max(plus_long, aretes[index][2]))
    repetee = sum(max(0.0, total - plus_long)
                  for total, plus_long in par_couloir.values())
    return longueur, repetee, trajet_total


def construit_boucle(adjacence, aretes, coords, index_spatial, depart,
                     lat, lon, rayon, cap, sommets, couloirs=None,
                     cible_m=None):
    """Boucle passant par `sommets` ancres reparties en couronne autour du
    depart. Chaque troncon evite les aretes deja utilisees."""
    ancres = []
    for i in range(sommets):
        angle = (cap + i * 360.0 / sommets) % 360.0
        cible_lat, cible_lon = point_a_distance(lat, lon, angle, rayon)
        noeud, ecart = index_spatial.plus_proche(cible_lat, cible_lon,
                                                 rayon_max=max(400.0, rayon * 0.45))
        if noeud is None or noeud == depart or noeud in ancres:
            continue
        ancres.append(noeud)
    if len(ancres) < 2:
        return None

    etapes = [depart] + ancres + [depart]
    return _assemble(adjacence, aretes, coords, etapes, couloirs, cible_m)


def virages_serres(trajet, aretes, coords, longueur):
    """Changements de direction brutaux par kilometre.

    C'est la signature des petits crochets qui rallongent un parcours sans
    rien lui apporter : on entre dans une rue, on la ressort aussitot. Mesure
    volontairement locale : elle ne penalise pas une boucle allongee, qui est
    parfaitement agreable a courir, seulement une boucle qui zigzague.
    """
    noeuds = polyligne_du_trajet(trajet, aretes)
    if len(noeuds) < 3 or longueur <= 0:
        return 0.0
    compte = 0
    precedent = None
    for a, b in zip(noeuds, noeuds[1:]):
        lat1, lon1 = coords[a]
        lat2, lon2 = coords[b]
        # Les micro-segments qui dessinent un virage cartographie ne comptent
        # pas : on ne veut que les vrais changements de cap.
        if abs(lat2 - lat1) < 9e-5 and abs(lon2 - lon1) < 1.4e-4:
            continue
        cap = math.degrees(math.atan2(
            (lon2 - lon1) * math.cos(math.radians(lat1)), lat2 - lat1))
        if precedent is not None:
            if abs((cap - precedent + 180) % 360 - 180) > 100:
                compte += 1
        precedent = cap
    return compte / (longueur / 1000.0)


def points_intermediaires(depart_ll, arrivee_ll, hauteur, nombre):
    """Points de passage sur un arc reliant le depart a l'arrivee.

    L'arc est bombe de `hauteur` metres au milieu (hauteur negative = bombe de
    l'autre cote). C'est l'equivalent, pour un trajet d'un point a un autre,
    de la couronne d'ancres utilisee pour les boucles : la distance demandee
    s'obtient en creusant le detour, jamais en faisant des va-et-vient.
    """
    lat1, lon1 = depart_ll
    lat2, lon2 = arrivee_ll
    direct = cap_entre(lat1, lon1, lat2, lon2)
    corde = distance_haversine(lat1, lon1, lat2, lon2)
    points = []
    for i in range(1, nombre + 1):
        part = i / (nombre + 1.0)
        base_lat, base_lon = point_a_distance(lat1, lon1, direct, corde * part)
        ecart = hauteur * math.sin(math.pi * part)
        cote = (direct + 90.0) % 360.0 if ecart >= 0 else (direct - 90.0) % 360.0
        points.append(point_a_distance(base_lat, base_lon, cote, abs(ecart)))
    return points


def construit_trajet(adjacence, aretes, coords, index_spatial, depart, arrivee,
                     depart_ll, arrivee_ll, hauteur, nombre, couloirs=None,
                     cible_m=None):
    """Trajet depart -> arrivee passant par un arc de `nombre` points."""
    etapes = [depart]
    for cible_lat, cible_lon in points_intermediaires(depart_ll, arrivee_ll,
                                                      hauteur, nombre):
        noeud, _ = index_spatial.plus_proche(
            cible_lat, cible_lon, rayon_max=max(400.0, abs(hauteur) * 0.6))
        if noeud is not None and noeud not in etapes:
            etapes.append(noeud)
    etapes.append(arrivee)
    return _assemble(adjacence, aretes, coords, etapes, couloirs, cible_m)


def cherche_trajet(adjacence, aretes, coords, index_spatial, depart, arrivee,
                   depart_ll, arrivee_ll, cible_m, nombre, cote, iterations,
                   tolerance, variantes=None, couloirs=None):
    """Dichotomie sur le bombement de l'arc pour atteindre la distance visee."""
    corde = distance_haversine(depart_ll[0], depart_ll[1],
                               arrivee_ll[0], arrivee_ll[1])
    # Hauteur qui donnerait la longueur voulue si le detour etait un triangle.
    reste = max(0.0, (cible_m / 2.0) ** 2 - (corde / 2.0) ** 2)
    bas, haut = 0.0, math.sqrt(reste) * 1.7 + 300.0
    meilleur = None

    for _ in range(iterations):
        hauteur = (bas + haut) / 2.0
        essai = construit_trajet(adjacence, aretes, coords, index_spatial,
                                 depart, arrivee, depart_ll, arrivee_ll,
                                 hauteur * cote, nombre, couloirs, cible_m)
        if essai is None:
            haut = hauteur
            continue
        longueur, repetee, trajet = essai
        note = note_boucle(longueur, repetee, cible_m, tolerance,
                           virages_serres(trajet, aretes, coords, longueur))
        essai_note = (note, longueur, repetee, trajet, nombre, cote, hauteur)
        # Toutes les tentatives valides sont conservees, pas seulement la
        # meilleure : le controle geometrique final a besoin de matiere pour
        # trouver un trace sans defaut, et la dichotomie en produit dix.
        if variantes is not None:
            variantes.append(essai_note)
        if meilleur is None or note < meilleur[0]:
            meilleur = essai_note
        if longueur < cible_m:
            bas = hauteur
        else:
            haut = hauteur
    return meilleur


def affine_trajet(adjacence, aretes, coords, index_spatial, depart, arrivee,
                  depart_ll, arrivee_ll, cible_m, tolerance, repetition_max,
                  meilleur, variantes=None, couloirs=None):
    """Balayage fin du bombement autour du meilleur trajet trouve."""
    _, _, _, _, nombre, cote, hauteur = meilleur
    for facteur in (0.84, 0.88, 0.92, 0.96, 1.04, 1.08, 1.12, 1.16):
        essai = construit_trajet(adjacence, aretes, coords, index_spatial,
                                 depart, arrivee, depart_ll, arrivee_ll,
                                 hauteur * facteur * cote, nombre, couloirs,
                                 cible_m)
        if essai is None:
            continue
        longueur, repetee, trajet = essai
        if longueur and repetee / longueur > repetition_max:
            continue
        note = note_boucle(longueur, repetee, cible_m, tolerance,
                           virages_serres(trajet, aretes, coords, longueur))
        essai_note = (note, longueur, repetee, trajet, nombre, cote,
                      hauteur * facteur)
        if variantes is not None:
            variantes.append(essai_note)
        if note < meilleur[0]:
            meilleur = essai_note
    return meilleur


def note_boucle(longueur, repetee, cible_m, tolerance, virages=0.0):
    """Classement des boucles candidates, du meilleur au moins bon.

    Criteres successifs, par tranches d'un demi-pour-cent pour ne pas
    departager sur du bruit :
      1. la boucle se repete le moins possible (pas de demi-tour) ;
      2. elle colle au plus pres de la distance demandee ;
      3. a egalite, celle qui zigzague le moins l'emporte.
    """
    erreur = abs(longueur - cible_m) / cible_m
    part = repetee / longueur if longueur else 1.0
    if erreur <= tolerance:
        return (0, round(part * 200), round(erreur * 200), virages)
    return (1, erreur, part, virages)


def cherche_boucle(adjacence, aretes, coords, index_spatial, depart, lat, lon,
                   cible_m, cap, sommets, iterations, tolerance,
                   variantes=None, couloirs=None):
    """Dichotomie sur le rayon de la couronne d'ancres : la distance cible est
    atteinte en elargissant la boucle, jamais en la faisant zigzaguer."""
    rayon_ideal = cible_m / (2 * sommets * math.sin(math.pi / sommets))
    bas, haut = rayon_ideal * 0.25, rayon_ideal * 1.60
    meilleur = None

    for _ in range(iterations):
        rayon = (bas + haut) / 2.0
        essai = construit_boucle(adjacence, aretes, coords, index_spatial,
                                 depart, lat, lon, rayon, cap, sommets,
                                 couloirs, cible_m)
        if essai is None:
            haut = rayon
            continue
        longueur, repetee, trajet = essai
        note = note_boucle(longueur, repetee, cible_m, tolerance,
                           virages_serres(trajet, aretes, coords, longueur))
        essai_note = (note, longueur, repetee, trajet, sommets, cap, rayon)
        # Meme reserve que pour un parcours d'un point a un autre.
        if variantes is not None:
            variantes.append(essai_note)
        if meilleur is None or note < meilleur[0]:
            meilleur = essai_note
        if longueur < cible_m:
            bas = rayon
        else:
            haut = rayon

    return meilleur


def affine_boucle(adjacence, aretes, coords, index_spatial, depart, lat, lon,
                  cible_m, tolerance, repetition_max, meilleur,
                  variantes=None, couloirs=None):
    """Balayage fin autour de la meilleure boucle trouvee.

    Le balayage large teste des orientations tous les 22 degres et des rayons
    issus d'une dichotomie : la bonne boucle se trouve souvent juste a cote.
    On rejoue donc de petites rotations et de petites variations de rayon,
    ce qui coute quelques dizaines de calculs et gagne reguliserement une
    centaine de metres sur la distance visee.
    """
    _, _, _, _, sommets, cap, rayon = meilleur
    for decalage in (-9.0, -6.0, -3.0, 3.0, 6.0, 9.0, 0.0):
        for facteur in (0.88, 0.92, 0.96, 1.0, 1.04, 1.08, 1.12):
            if decalage == 0.0 and facteur == 1.0:
                continue                  # deja teste
            essai = construit_boucle(adjacence, aretes, coords, index_spatial,
                                     depart, lat, lon, rayon * facteur,
                                     (cap + decalage) % 360.0, sommets,
                                     couloirs, cible_m)
            if essai is None:
                continue
            longueur, repetee, trajet = essai
            if longueur and repetee / longueur > repetition_max:
                continue
            note = note_boucle(longueur, repetee, cible_m, tolerance,
                               virages_serres(trajet, aretes, coords, longueur))
            essai_note = (note, longueur, repetee, trajet, sommets,
                          (cap + decalage) % 360.0, rayon * facteur)
            if variantes is not None:
                variantes.append(essai_note)
            if note < meilleur[0]:
                meilleur = essai_note
    return meilleur


# ---------------------------------------------------------------------------
# Controle geometrique du trace produit
# ---------------------------------------------------------------------------
# Le compteur de repetition compare des identifiants d'aretes : il voit un
# aller-retour sur la meme voie, mais pas un aller par la rue et un retour par
# le trottoir cartographie a part, qui sont deux aretes distinctes. Il ne voit
# pas davantage une petite boucle refermee sur elle-meme, qui n'emprunte
# aucune arete deux fois. A l'ecran, ces deux defauts sautent pourtant aux
# yeux. On les mesure donc sur la geometrie finale, sans rien supposer de leur
# cause.
MARGE_REPLI = 0.20          # ce qu'un repli a le droit de couter en distance

# Combien de candidats le controle geometrique examine, du meilleur au moins
# bon. Les traces sans defaut ne sont pas forcement les mieux classes sur la
# distance : en regarder une poignee ne suffisait pas a en trouver un.
CANDIDATS_EXAMINES = 120

# Nombre de points de passage essayes pour un parcours d'un point a un autre.
# Au-dela de quatre, l'arc se plie assez pour tenir une longue distance entre
# deux points proches sans se refermer en lacets.
POINTS_DE_PASSAGE = (1, 2, 3, 4, 5, 6)


def distance_point_segment(plat, plon, alat, alon, blat, blon):
    """Distance d'un point au segment [A,B], en metres (approximation locale)."""
    cos = math.cos(math.radians(plat))
    mx = 111320.0                          # metres par degre de latitude
    px, py = (plon - alon) * mx * cos, (plat - alat) * mx
    bx, by = (blon - alon) * mx * cos, (blat - alat) * mx
    norme = bx * bx + by * by
    if norme == 0:
        return math.hypot(px, py)
    t = (px * bx + py * by) / norme
    t = 0.0 if t < 0 else (1.0 if t > 1 else t)
    return math.hypot(px - t * bx, py - t * by)


def _cumul(points):
    """Longueurs cumulees le long du trace."""
    cumul = [0.0] * len(points)
    for i in range(1, len(points)):
        cumul[i] = cumul[i - 1] + distance_haversine(
            points[i - 1][0], points[i - 1][1], points[i][0], points[i][1])
    return cumul


def mesure_doublement(points, seuil=15.0, ecart_chemin=80.0):
    """Longueur du trace qui longe une autre portion du meme trace.

    A moins de `seuil` metres d'elle, alors qu'elle en est eloignee d'au moins
    `ecart_chemin` metres le long du parcours. Les deux passages sont comptes :
    un aller-retour de 150 m rend environ 300 m.
    """
    n = len(points)
    if n < 4:
        return {"longueur": 0.0, "portions": []}

    cumul = _cumul(points)
    total = cumul[n - 1]
    # Sur une boucle fermee, le debut et la fin sont voisins : l'ecart le long
    # du chemin doit se mesurer dans les deux sens.
    ferme = distance_haversine(points[0][0], points[0][1],
                               points[n - 1][0], points[n - 1][1]) < 25

    def ecart_le_long_du_chemin(a, b):
        d = abs(cumul[a] - cumul[b])
        return min(d, total - d) if ferme else d

    # Grille spatiale sur les milieux de segments.
    case = 40.0
    cases = {}
    mlat = [0.0] * (n - 1)
    mlon = [0.0] * (n - 1)
    for s in range(n - 1):
        mlat[s] = (points[s][0] + points[s + 1][0]) / 2
        mlon[s] = (points[s][1] + points[s + 1][1]) / 2
        ci = math.floor(mlat[s] * 111320 / case)
        cj = math.floor(mlon[s] * 111320 * math.cos(math.radians(mlat[s])) / case)
        cases.setdefault((ci, cj), []).append(s)

    double = [False] * (n - 1)
    for s in range(n - 1):
        ci = math.floor(mlat[s] * 111320 / case)
        cj = math.floor(mlon[s] * 111320 * math.cos(math.radians(mlat[s])) / case)
        for di in (-1, 0, 1):
            if double[s]:
                break
            for dj in (-1, 0, 1):
                if double[s]:
                    break
                for t in cases.get((ci + di, cj + dj), ()):
                    if t == s or ecart_le_long_du_chemin(s, t) < ecart_chemin:
                        continue
                    d = distance_point_segment(mlat[s], mlon[s],
                                               points[t][0], points[t][1],
                                               points[t + 1][0], points[t + 1][1])
                    if d < seuil:
                        double[s] = True
                        break

    portions, debut = [], -1
    for s in range(n - 1):
        if double[s]:
            if debut < 0:
                debut = s
        elif debut >= 0:
            portions.append({"debut": debut, "fin": s,
                             "longueur": cumul[s] - cumul[debut]})
            debut = -1
    if debut >= 0:
        portions.append({"debut": debut, "fin": n - 1,
                         "longueur": cumul[n - 1] - cumul[debut]})

    # Une portion isolee de quelques metres releve du bruit de numerisation,
    # pas d'un aller-retour : on ne retient que les portions significatives.
    retenues = [p for p in portions if p["longueur"] >= 25]
    return {"longueur": sum(p["longueur"] for p in retenues),
            "portions": retenues}


def mesure_bouclettes(points, seuil=25.0, minimum=60.0, part_max=0.25):
    """Petites boucles refermees sur elles-memes a l'interieur du parcours.

    Un crochet qui part d'un carrefour, fait le tour d'un pate de maisons et
    revient au meme carrefour n'emprunte aucune arete deux fois et ne longe
    rien : ni le comptage de repetition ni la mesure de doublement ne le
    voient. C'est pourtant exactement ce qu'on ne veut pas, un circuit plus
    trois lacets pour faire la distance.

    Une bouclette est un retour du trace a moins de `seuil` metres d'un point
    deja visite, apres avoir parcouru entre `minimum` metres et une part
    `part_max` du parcours. La borne haute ecarte la fermeture de la boucle
    principale, qui est le but recherche et non un defaut.
    """
    n = len(points)
    if n < 4:
        return {"nombre": 0, "longueur": 0.0, "boucles": []}

    cumul = _cumul(points)
    maximum = cumul[n - 1] * part_max
    if maximum <= minimum:
        return {"nombre": 0, "longueur": 0.0, "boucles": []}

    # Grille spatiale sur les points, au pas du seuil : deux points voisins
    # dans le plan tombent dans la meme case ou dans une case adjacente.
    case = max(10.0, seuil)

    def case_de(k):
        return (math.floor(points[k][0] * 111320 / case),
                math.floor(points[k][1] * 111320
                           * math.cos(math.radians(points[k][0])) / case))

    cases = {}
    for k in range(n):
        cases.setdefault(case_de(k), []).append(k)

    # Pour chaque point, le retour le plus tardif encore admissible : c'est la
    # plus grande bouclette qui se referme sur ce point.
    intervalles = []
    for i in range(n):
        ci, cj = case_de(i)
        fin = -1
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for j in cases.get((ci + di, cj + dj), ()):
                    if j <= i or j <= fin:
                        continue
                    parcouru = cumul[j] - cumul[i]
                    if parcouru < minimum or parcouru > maximum:
                        continue
                    if distance_haversine(points[i][0], points[i][1],
                                          points[j][0], points[j][1]) > seuil:
                        continue
                    fin = j
        if fin > i:
            intervalles.append((i, fin))

    # Deux bouclettes qui se recouvrent sont le meme crochet vu de deux points.
    boucles = []
    for debut, fin in intervalles:
        if boucles and debut <= boucles[-1]["fin"]:
            if fin > boucles[-1]["fin"]:
                boucles[-1]["fin"] = fin
        else:
            boucles.append({"debut": debut, "fin": fin})
    for b in boucles:
        b["longueur"] = cumul[b["fin"]] - cumul[b["debut"]]

    return {"nombre": len(boucles),
            "longueur": sum(b["longueur"] for b in boucles),
            "boucles": boucles}


def seuils_geometriques(cible_m):
    """Ce qu'on accepte de laisser passer sur le dessin final.

    Une portion longee se compte en part de la distance ; une bouclette, elle,
    n'a pas de taille acceptable : le seuil vaut le plancher de detection,
    donc toute bouclette reperee compte.
    """
    return {"doublement": max(30.0, cible_m * 0.005), "bouclettes": 60.0}


def choisit_trace_propre(meilleur, reserve, cible, seuils, points_de, maximum):
    """Choisit le candidat dont le dessin tient la route.

    Les candidats arrivent classes du meilleur au moins bon. Le repli ne porte
    que sur ceux qui tiennent encore la distance : sans ce garde-fou, le plus
    court chemin direct — qui ne double evidemment rien, puisqu'il ne fait
    aucun detour — finirait par etre retenu. Mieux vaut un parcours qui longe
    cent metres de lui-meme, et le dire, qu'un parcours dix fois trop court.

    Ordre de preference : d'abord un trace sans rien a redire, sinon un trace
    qui ne longe pas une portion de lui-meme, sinon le meilleur tel quel.
    """
    def erreur_de(candidat):
        return abs(candidat[1] - cible) / cible

    erreur_max = erreur_de(meilleur) + MARGE_REPLI
    candidats = [meilleur] + [c for c in reserve
                              if c is not meilleur and erreur_de(c) <= erreur_max]
    candidats = candidats[:maximum]

    mesures, sans_doublement = [], None
    for candidat in candidats:
        points = points_de(candidat)
        mesure = (candidat, mesure_doublement(points), mesure_bouclettes(points))
        mesures.append(mesure)
        if mesure[1]["longueur"] > seuils["doublement"]:
            continue
        if mesure[2]["longueur"] <= seuils["bouclettes"]:
            return mesure
        if sans_doublement is None:
            sans_doublement = mesure
    return sans_doublement if sans_doublement is not None else mesures[0]


def annonce_defauts(journal, quoi, remplace, doublement, bouclettes, seuils):
    """Dit ce qui reste a redire sur le trace retenu, plutot que de le taire."""
    if remplace:
        journal("  le meilleur {} avait un defaut de trace : candidat suivant "
                "retenu".format(quoi))
    if doublement["longueur"] > seuils["doublement"]:
        journal("  aucun {} sans portion doublee a cette distance : le meilleur "
                "longe {:.0f} m de lui-meme".format(quoi, doublement["longueur"]))
    if bouclettes["longueur"] > seuils["bouclettes"]:
        journal("  aucun {} sans petite boucle a cette distance : il en reste "
                "{} ({:.0f} m au total)".format(quoi, bouclettes["nombre"],
                                                bouclettes["longueur"]))


# ---------------------------------------------------------------------------
# Voies jumelles : les couloirs
# ---------------------------------------------------------------------------
# Une rue et son trottoir cartographie a part sont deux aretes distinctes du
# graphe, alors qu'ils sont physiquement la meme voie. La penalite qui empeche
# de reprendre une arete deja parcourue ne les reliait pas : on pouvait aller
# par la rue et revenir par le trottoir sans que rien ne le remarque. Ici, ces
# aretes sont reunies dans un meme couloir, et la penalite comme le comptage
# de repetition raisonnent par couloir.
#
# Le regroupement sert une seconde fin : quand les deux bords d'une chaussee
# sont cartographies, on sait de quel cote on court. Hors agglomeration, le
# code de la route francais demande au pieton de circuler pres du bord gauche,
# face au trafic.
SURCOUT_COTE_DROIT = 1.35


class Couloirs:
    """Appartenance des aretes aux couloirs, et cote de la chaussee.

    `couloir[i]` est l'identifiant du couloir de l'arete i ; sans jumelle il
    vaut i et tout se comporte comme s'il n'y avait pas de couloirs.
    `decalage[i]` est l'ecart lateral de l'arete i par rapport a l'arete de
    reference de son couloir, en metres, compte positivement a gauche du sens
    de cette reference ; `alignement[i]` vaut +1 si l'arete i va dans le meme
    sens que la reference, -1 sinon.
    """

    def __init__(self, couloir, decalage, alignement, nb_jumelages):
        self.couloir = couloir
        self.decalage = decalage
        self.alignement = alignement
        self.nb_jumelages = nb_jumelages

    @classmethod
    def aucun(cls, nombre):
        return cls(list(range(nombre)), [0.0] * nombre, [1] * nombre, 0)

    def surcout(self, index, depuis, aretes):
        """Surcout du cote droit, pour une arete parcourue depuis `depuis`."""
        ecart = self.decalage[index]
        if ecart == 0.0:
            return 1.0
        sens = (1 if depuis == aretes[index][0] else -1) * self.alignement[index]
        return SURCOUT_COTE_DROIT if ecart * sens < 0 else 1.0


def _echantillonne(arete, coords, maximum=16):
    """Echantillonne la polyligne d'une arete, au plus `maximum` points."""
    p = arete[4]
    pas = max(1, math.ceil(len(p) / maximum))
    points = [coords[p[k]] for k in range(0, len(p), pas)]
    if points[-1] != coords[p[-1]]:
        points.append(coords[p[-1]])
    return points


def _recouvrement(ech_a, arete_b, coords, seuil):
    """Part des echantillons de A a moins de `seuil` de la polyligne de B."""
    p = arete_b[4]
    proches = 0
    for plat, plon in ech_a:
        meilleure = float("inf")
        for k in range(len(p) - 1):
            if meilleure < seuil:
                break
            alat, alon = coords[p[k]]
            blat, blon = coords[p[k + 1]]
            d = distance_point_segment(plat, plon, alat, alon, blat, blon)
            if d < meilleure:
                meilleure = d
        if meilleure < seuil:
            proches += 1
    return proches / len(ech_a)


def _vecteur(arete, coords):
    """Vecteur d'une arete, de son debut vers sa fin, en metres (est, nord)."""
    p = arete[4]
    alat, alon = coords[p[0]]
    blat, blon = coords[p[-1]]
    cos = math.cos(math.radians(alat))
    return ((blon - alon) * 111320 * cos, (blat - alat) * 111320)


def detecte_corridors(aretes, coords, ecart_max=14.0, recouvrement_min=0.65,
                      longueur_min=25.0, maximum_paires=400000):
    """Regroupe les voies jumelles et calcule le cote de chaussee de chacune."""
    n = len(aretes)
    parent = list(range(n))

    def trouve(x):
        r = x
        while parent[r] != r:
            r = parent[r]
        while parent[x] != r:
            parent[x], x = r, parent[x]
        return r

    def unit(a, b):
        ra, rb = trouve(a), trouve(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)

    case = 30.0
    cases = {}
    echantillons = [None] * n
    for i in range(n):
        if aretes[i][2] < longueur_min:
            continue
        ech = _echantillonne(aretes[i], coords)
        echantillons[i] = ech
        for plat, plon in ech:
            ci = math.floor(plat * 111320 / case)
            cj = math.floor(plon * 111320 * math.cos(math.radians(plat)) / case)
            for di in (-1, 0, 1):
                for dj in (-1, 0, 1):
                    cases.setdefault((ci + di, cj + dj), set()).add(i)

    # Paires candidates : deux aretes qui partagent au moins une case.
    vues = set()
    jumelages = examinees = 0
    for liste in cases.values():
        if len(liste) < 2:
            continue
        tableau = sorted(liste)
        for a in range(len(tableau)):
            for b in range(a + 1, len(tableau)):
                i, j = tableau[a], tableau[b]
                if (i, j) in vues:
                    continue
                vues.add((i, j))
                examinees += 1
                if examinees > maximum_paires:
                    break
                li, lj = aretes[i][2], aretes[j][2]
                # Deux voies jumelles ont des longueurs comparables : sans ce
                # garde-fou, une arete courte serait absorbee par une longue
                # qu'elle ne fait que croiser.
                if li > lj * 2.2 or lj > li * 2.2:
                    continue
                if _recouvrement(echantillons[i], aretes[j], coords,
                                 ecart_max) < recouvrement_min:
                    continue
                if _recouvrement(echantillons[j], aretes[i], coords,
                                 ecart_max) < recouvrement_min:
                    continue
                unit(i, j)
                jumelages += 1

    couloir = [trouve(i) for i in range(n)]

    # Cote de la chaussee. Seules les aretes jumelees en ont un : ailleurs, la
    # voie est cartographiee par son axe et le trace ne peut pas designer un
    # bord plutot que l'autre.
    decalage = [0.0] * n
    alignement = [1] * n
    for i in range(n):
        reference = couloir[i]
        if reference == i:
            continue
        rx, ry = _vecteur(aretes[reference], coords)
        norme = math.hypot(rx, ry)
        if norme < 1:
            continue
        ix, iy = _vecteur(aretes[i], coords)
        alignement[i] = 1 if (ix * rx + iy * ry) >= 0 else -1

        p = aretes[i][4]
        mlat, mlon = coords[p[len(p) // 2]]
        q = aretes[reference][4]
        alat, alon = coords[q[0]]
        cos = math.cos(math.radians(alat))
        ox, oy = (mlon - alon) * 111320 * cos, (mlat - alat) * 111320
        decalage[i] = (rx * oy - ry * ox) / norme

    return Couloirs(couloir, decalage, alignement, jumelages)


# ---------------------------------------------------------------------------
# Sortie
# ---------------------------------------------------------------------------
def polyligne_du_trajet(trajet, aretes):
    """Suite de noeuds parcourus, dans l'ordre, sans doublon consecutif."""
    noeuds = []
    for index, depuis in trajet:
        u, _, _, _, polyligne, _, _ = aretes[index]
        segment = polyligne if depuis == u else list(reversed(polyligne))
        if noeuds and noeuds[-1] == segment[0]:
            noeuds.extend(segment[1:])
        else:
            noeuds.extend(segment)
    return noeuds


def repartition(trajet, aretes, champ):
    """Metres parcourus par valeur du champ (5 = type de voie, 6 = revetement)."""
    totaux = {}
    for index, _ in trajet:
        cle = aretes[index][champ]
        totaux[cle] = totaux.get(cle, 0.0) + aretes[index][2]
    return sorted(totaux.items(), key=lambda t: -t[1])


def allege(points, maximum):
    if len(points) <= maximum:
        return points
    pas = math.ceil(len(points) / maximum)
    reduit = points[::pas]
    if reduit[-1] != points[-1]:
        reduit.append(points[-1])
    return reduit


def ecrit_gpx(points, nom, chemin):
    lignes = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.1" creator="generateur-boucle-gpx"',
        '     xmlns="http://www.topografix.com/GPX/1/1"',
        '     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
        '     xsi:schemaLocation="http://www.topografix.com/GPX/1/1'
        ' http://www.topografix.com/GPX/1/1/gpx.xsd">',
        "  <metadata>",
        "    <name>{}</name>".format(nom),
        # Le trace derive des donnees OpenStreetMap, sous licence ODbL :
        # l'attribution voyage donc avec le fichier, pas seulement avec le
        # depot. Tous les lecteurs GPX serieux ignorent ce bloc sans broncher.
        '    <copyright author="OpenStreetMap contributors">',
        "      <license>https://opendatacommons.org/licenses/odbl/</license>",
        "    </copyright>",
        "  </metadata>",
        "  <trk>",
        "    <name>{}</name>".format(nom),
        "    <trkseg>",
    ]
    for lat, lon in points:
        lignes.append('      <trkpt lat="{:.6f}" lon="{:.6f}"></trkpt>'.format(lat, lon))
    lignes += ["    </trkseg>", "  </trk>", "</gpx>", ""]
    with open(chemin, "w", encoding="utf-8") as fichier:
        fichier.write("\n".join(lignes))


def ecrit_geojson(points, chemin):
    contenu = {
        "type": "Feature",
        "properties": {},
        "geometry": {"type": "LineString",
                     "coordinates": [[lon, lat] for lat, lon in points]},
    }
    with open(chemin, "w", encoding="utf-8") as fichier:
        json.dump(contenu, fichier)


def nom_horodate(km):
    """Nom de fichier unique et trie chronologiquement par ordre alphabetique :
    2026-09-09_18h45_7.0km.gpx"""
    return "{}_{:.1f}km.gpx".format(time.strftime("%Y-%m-%d_%Hh%M"), km)


def nom_trace(km, boucle=True):
    """Nom affiche dans la montre : la distance et la date de creation."""
    return "{} {:.1f} km du {}".format("Boucle" if boucle else "Parcours",
                                       km, time.strftime("%d/%m/%Y"))


def chemin_disponible(chemin):
    if not os.path.exists(chemin):
        return chemin
    base, ext = os.path.splitext(chemin)
    indice = 1
    while True:
        candidat = "{}_{}{}".format(base, indice, ext)
        if not os.path.exists(candidat):
            return candidat
        indice += 1


# ---------------------------------------------------------------------------
LIBELLES_QUALITE = {
    "balise": "itineraire balise",
    "dure": "revetement dur",
    "meuble": "terre / stabilise",
    "voirie": "trottoir / rue",
    "inconnue": "chemin nomme ou eclaire",
}


class BoucleIntrouvable(Exception):
    """Aucune boucle satisfaisant les criteres n'a pu etre construite."""


def trace_vers_arrivee(coeur, aretes, coords, index_coeur, depart,
                       noeud_arrivee, depart_ll, arrivee_ll, cible_m, amorce,
                       amorce_arrivee, longueur_amorce, longueur_amorce_arrivee,
                       iterations, tolerance, repetition_max, max_points,
                       ecart_depart, journal, couloirs=None):
    """Cherche un parcours du depart vers une arrivee distincte.

    Meme principe que pour une boucle : la distance demandee s'obtient en
    creusant un detour en arc de cercle, jamais en ajoutant des va-et-vient.
    On essaie plusieurs nombres de points de passage et les deux cotes de
    l'arc, puis on affine autour du meilleur.
    """
    budget = cible_m - longueur_amorce - longueur_amorce_arrivee

    # Le plus court chemin donne la distance minimale possible : en deca,
    # aucun detour ne peut raccourcir, autant le dire tout de suite.
    direct = plus_court_chemin(coeur, aretes, coords, depart, noeud_arrivee,
                               couloirs=couloirs)
    if direct is None:
        raise BoucleIntrouvable(
            "Aucun itineraire praticable ne relie le depart a l'arrivee.")
    minimum = longueur_trajet(direct[1], aretes)
    total_minimum = minimum + longueur_amorce + longueur_amorce_arrivee
    if budget < minimum * 0.98:
        raise BoucleIntrouvable(
            "Distance trop courte : le plus court chemin praticable entre ces "
            "deux points fait deja {:.2f} km.".format(total_minimum / 1000.0))

    journal("4/5 Recherche du parcours (plus court chemin : {:.2f} km)"
            .format(total_minimum / 1000.0))
    meilleur = None
    # Toutes les tentatives valides sont gardees en reserve : si le meilleur
    # candidat se revele avoir un defaut de trace, on prend le suivant plutot
    # que de le servir tel quel.
    variantes = []
    for nombre in POINTS_DE_PASSAGE:
        ligne = "  {} point(s) de passage :".format(nombre)
        for cote, libelle in ((1.0, "gauche"), (-1.0, "droite")):
            essai = cherche_trajet(coeur, aretes, coords, index_coeur, depart,
                                   noeud_arrivee, depart_ll, arrivee_ll,
                                   budget, nombre, cote, iterations, tolerance,
                                   variantes, couloirs)
            if essai is None:
                ligne += "  {} : -".format(libelle)
                continue
            note, longueur, repetee = essai[:3]
            part = repetee / longueur if longueur else 1.0
            ligne += "  {} : {:.2f} km / {:.0f} %".format(
                libelle,
                (longueur + longueur_amorce + longueur_amorce_arrivee) / 1000.0,
                part * 100)
            if part > repetition_max:
                continue
            if meilleur is None or note < meilleur[0]:
                meilleur = essai
        journal(ligne)

    if meilleur is None:
        raise BoucleIntrouvable(
            "Aucun parcours sans aller-retour trouve pour cette distance "
            "entre ces deux points. Essayer une distance differente.")

    precedent = meilleur
    meilleur = affine_trajet(coeur, aretes, coords, index_coeur, depart,
                             noeud_arrivee, depart_ll, arrivee_ll, budget,
                             tolerance, repetition_max, meilleur, variantes,
                             couloirs)
    if meilleur is not precedent:
        journal("  affinage : {:.2f} km -> {:.2f} km, repetition {:.0f} -> "
                "{:.0f} m, crochets {:.2f} -> {:.2f} par km"
                .format((precedent[1] + longueur_amorce
                         + longueur_amorce_arrivee) / 1000.0,
                        (meilleur[1] + longueur_amorce
                         + longueur_amorce_arrivee) / 1000.0,
                        precedent[2], meilleur[2],
                        precedent[0][3], meilleur[0][3]))

    # Controle geometrique, sur le dessin et non sur le graphe : un parcours
    # peut longer une portion de lui-meme par la rue a l'aller et le trottoir
    # au retour, ou se refermer en petites boucles, sans qu'aucune arete ne
    # soit empruntee deux fois.
    seuils = seuils_geometriques(cible_m)

    def points_de(essai):
        return allege([coords[n] for n in polyligne_du_trajet(essai[3], aretes)],
                      max_points)

    reserve = [c for c in variantes
               if not (c[1] and c[2] / c[1] > repetition_max)]
    reserve.sort(key=lambda c: c[0])
    choisi, doublement, bouclettes = choisit_trace_propre(
        meilleur, reserve, budget, seuils, points_de, CANDIDATS_EXAMINES)
    annonce_defauts(journal, "parcours", choisi is not meilleur,
                    doublement, bouclettes, seuils)
    meilleur = choisi

    _, longueur, repetee, trajet, nombre, cote, _ = meilleur

    # 5. assemblage : amorce du depart, parcours, amorce de l'arrivee -------
    noeuds = list(polyligne_du_trajet(amorce, aretes)) if amorce else []
    coeur_trace = polyligne_du_trajet(trajet, aretes)
    noeuds.extend(coeur_trace[1:] if noeuds and noeuds[-1] == coeur_trace[0]
                  else coeur_trace)
    if amorce_arrivee:
        # rejoint_coeur part de l'arrivee : on le remet dans le bon sens.
        fin = list(reversed(polyligne_du_trajet(amorce_arrivee, aretes)))
        noeuds.extend(fin[1:] if noeuds[-1] == fin[0] else fin)

    points = allege([coords[n] for n in noeuds], max_points)
    distance = longueur + longueur_amorce + longueur_amorce_arrivee
    journal("5/5 Parcours retenu : {:.2f} km, {:.0f} m parcourus deux fois{}"
            .format(distance / 1000.0, repetee,
                    ", {:.0f} m longeant une autre portion".format(
                        doublement["longueur"]) if doublement["longueur"] > 0
                    else ""))

    return {
        "points": points,
        "distance": distance,
        "cible": cible_m,
        "repetee": repetee,
        "part_repetee": repetee / longueur if longueur else 0.0,
        "amorce": longueur_amorce + longueur_amorce_arrivee,
        "sommets": nombre,
        "cap": 0.0,
        "accroche": ecart_depart,
        "types": repartition(trajet, aretes, 5),
        "qualites": repartition(trajet, aretes, 6),
        "longueur_boucle": longueur,
        "boucle": False,
        "doublement": doublement["longueur"],
        "portions_doublees": len(doublement["portions"]),
        "bouclettes": bouclettes["longueur"],
        "nb_bouclettes": bouclettes["nombre"],
    }


def genere(lat, lon, cible_m, niveau="normal", caps=16, sommets=(3, 4, 5, 6),
           iterations=10, tolerance=0.03, repetition_max=0.12, max_points=3000,
           rafraichir=False, journal=print, arrivee=None):
    """Calcule la boucle et renvoie un dictionnaire decrivant le resultat.

    `arrivee` vaut None pour une boucle (retour au depart) ou (lat, lon) pour
    un parcours d'un point a un autre.

    `journal` recoit les lignes d'avancement : `print` en ligne de commande,
    une file d'attente quand l'appel vient de la carte interactive.
    Leve BoucleIntrouvable si aucun trace acceptable n'existe.
    """
    # 1. reseau OSM ---------------------------------------------------------
    # Rayon calibre sur l'ancre la plus eloignee que la recherche puisse
    # placer (au plus 0.31 x la cible), plus une marge confortable. Inutile de
    # telecharger deux fois plus loin : c'est autant d'attente en moins.
    rayon = cible_m * 0.40 + 800
    centre_lat, centre_lon = lat, lon
    if arrivee is not None:
        # Le telechargement doit couvrir le depart, l'arrivee et le detour :
        # on le centre sur le milieu et on l'elargit d'une demi-corde.
        centre_lat = (lat + arrivee[0]) / 2.0
        centre_lon = (lon + arrivee[1]) / 2.0
        rayon += distance_haversine(lat, lon, arrivee[0], arrivee[1]) / 2.0
    rayon = min(rayon, 25000)
    journal("1/5 Reseau OpenStreetMap dans un rayon de {:.0f} m".format(rayon))
    if rayon > 8000:
        journal("  zone etendue : compter quelques minutes la premiere fois, "
                "puis c'est en cache")

    # Les deux interrogations sont independantes : on les mene de front
    # plutot que l'une apres l'autre.
    resultats = {}

    def recupere(nom, fonction):
        try:
            resultats[nom] = fonction(centre_lat, centre_lon, rayon,
                                      rafraichir, journal)
        except Exception as erreur:                 # relayee au fil principal
            resultats[nom] = erreur

    fils = [threading.Thread(target=recupere, args=(nom, fonction))
            for nom, fonction in (("voies", telecharge_reseau),
                                  ("balises", telecharge_itineraires),
                                  ("barrieres", telecharge_barrieres))]
    for fil in fils:
        fil.start()
    for fil in fils:
        fil.join()
    # Sans le reseau, rien n'est possible. Sans les itineraires balises, si :
    # les chemins non documentes sont alors simplement refuses, ce qui rend le
    # filtrage plus severe et jamais moins sur.
    if isinstance(resultats["voies"], Exception):
        raise resultats["voies"]
    voies = resultats["voies"]
    barrieres = resultats["barrieres"]
    bloques = set() if isinstance(barrieres, Exception) \
        else noeuds_infranchissables(barrieres)
    if bloques:
        journal("  {} obstacles infranchissables releves (portails, clotures)"
                .format(len(bloques)))
    balises = resultats["balises"]
    if isinstance(balises, Exception):
        journal("  itineraires balises indisponibles : les chemins non "
                "documentes seront ecartes")
        balises = set()
    else:
        journal("  {} voies appartiennent a un itineraire pedestre balise"
                .format(len(balises)))

    # 2. filtrage de praticabilite -----------------------------------------
    journal("2/5 Filtrage de praticabilite")
    coords, brut, retenues = construit_graphe_brut(voies, niveau, balises,
                                                   bloques)
    journal("  {} voies sur {} retenues comme praticables ({} ecartees comme "
            "impraticables ou interdites)"
            .format(retenues, len(voies), len(voies) - retenues))
    if len(brut) < 50:
        raise BoucleIntrouvable(
            "Trop peu de voies praticables autour de ce point. Essayer le "
            "niveau tolerant, ou un depart plus proche d'une zone habitee.")

    index_complet = IndexSpatial(coords, brut.keys())
    depart_brut, ecart_depart = index_complet.plus_proche(lat, lon)
    if depart_brut is None:
        raise BoucleIntrouvable(
            "Aucun chemin praticable a proximite du point de depart choisi.")
    journal("  depart accroche a {:.0f} m du point demande".format(ecart_depart))

    arrivee_brut, ecart_arrivee = None, 0.0
    if arrivee is not None:
        arrivee_brut, ecart_arrivee = index_complet.plus_proche(*arrivee)
        if arrivee_brut is None:
            raise BoucleIntrouvable(
                "Aucun chemin praticable a proximite du point d'arrivee.")
        journal("  arrivee accrochee a {:.0f} m du point demande"
                .format(ecart_arrivee))

    # 3. suppression des impasses ------------------------------------------
    journal("3/5 Suppression des impasses (aucun demi-tour possible ensuite)")
    proteges = {depart_brut}
    if arrivee_brut is not None:
        proteges.add(arrivee_brut)      # sinon l'arrivee disparait du graphe
    aretes, adjacence = contracte(brut, coords, proteges)
    coeur = supprime_impasses(aretes, adjacence)
    journal("  {} aretes, {} apres elagage des culs-de-sac"
            .format(len(aretes), sum(len(v) for v in coeur.values()) // 2))

    couloirs = detecte_corridors(aretes, coords)
    if couloirs.nb_jumelages:
        journal("  {} voies doublees d'un trottoir cartographie a part : "
                "regroupees, pour qu'aller par l'une et revenir par l'autre "
                "compte comme un aller-retour".format(couloirs.nb_jumelages))

    if depart_brut in coeur:
        depart, amorce, longueur_amorce = depart_brut, [], 0.0
    else:
        # Le depart est sur une voie sans issue : on rejoint le premier point
        # du reseau maille, et cette amorce est le seul aller-retour inevitable.
        depart, amorce = rejoint_coeur(adjacence, aretes, depart_brut, coeur)
        if depart is None:
            raise BoucleIntrouvable("Depart isole du reseau praticable.")
        longueur_amorce = longueur_trajet(amorce, aretes)
        journal("  amorce depuis l'impasse du depart : {:.0f} m (seul "
                "aller-retour inevitable)".format(longueur_amorce))

    # L'arrivee, quand elle differe, recoit la meme amorce que le depart si
    # elle se trouve au fond d'une impasse.
    noeud_arrivee, amorce_arrivee, longueur_amorce_arrivee = depart, [], 0.0
    if arrivee is not None:
        if arrivee_brut in coeur:
            noeud_arrivee = arrivee_brut
        else:
            noeud_arrivee, amorce_arrivee = rejoint_coeur(
                adjacence, aretes, arrivee_brut, coeur)
            if noeud_arrivee is None:
                raise BoucleIntrouvable("Arrivee isolee du reseau praticable.")
            longueur_amorce_arrivee = longueur_trajet(amorce_arrivee, aretes)
        journal("  arrivee accrochee a {:.0f} m du point demande"
                .format(ecart_arrivee))

    atteignables = composante(coeur, depart)
    coeur = {n: [(v, i) for v, i in l if v in atteignables]
             for n, l in coeur.items() if n in atteignables}
    if len(coeur) < 20:
        raise BoucleIntrouvable("Reseau maille trop petit autour du depart.")
    if arrivee is not None and noeud_arrivee not in coeur:
        raise BoucleIntrouvable(
            "Aucun itineraire praticable ne relie le depart a l'arrivee. "
            "Verifier les deux points, ou assouplir le niveau d'exigence.")
    index_coeur = IndexSpatial(coords, coeur.keys())

    # 4. recherche ----------------------------------------------------------
    if arrivee is not None:
        return trace_vers_arrivee(
            coeur, aretes, coords, index_coeur, depart, noeud_arrivee,
            (lat, lon), arrivee, cible_m, amorce, amorce_arrivee,
            longueur_amorce, longueur_amorce_arrivee, iterations, tolerance,
            repetition_max, max_points, ecart_depart, journal, couloirs)

    budget = max(cible_m - 2 * longueur_amorce, cible_m * 0.3)
    journal("4/5 Recherche de la boucle ({} orientations x {} formes)"
            .format(caps, len(sommets)))
    meilleur = None
    # Meme reserve que pour un parcours d'un point a un autre.
    variantes = []
    testees = 0
    for index_cap in range(caps):
        cap = index_cap * 360.0 / caps
        ligne = "  cap {:3.0f} deg :".format(cap)
        for nb_sommets in sommets:
            testees += 1
            essai = cherche_boucle(coeur, aretes, coords, index_coeur, depart,
                                   lat, lon, budget, cap, nb_sommets,
                                   iterations, tolerance, variantes, couloirs)
            if essai is None:
                ligne += "  {}s: -".format(nb_sommets)
                continue
            note, longueur, repetee, trajet = essai[:4]
            part = repetee / longueur if longueur else 1.0
            ligne += "  {}s: {:.2f}km/{:.0f}%".format(
                nb_sommets, (longueur + 2 * longueur_amorce) / 1000.0, part * 100)
            if part > repetition_max:
                continue        # trop d'aller-retours : ecarte d'office
            if meilleur is None or note < meilleur[0]:
                meilleur = essai
        journal(ligne)

    if meilleur is None:
        raise BoucleIntrouvable(
            "Aucune boucle sans aller-retour trouvee pour cette distance. "
            "Essayer une distance un peu differente, un autre depart, ou un "
            "niveau d'exigence moins severe.")

    avant = meilleur
    meilleur = affine_boucle(coeur, aretes, coords, index_coeur, depart,
                             lat, lon, budget, tolerance, repetition_max,
                             meilleur, variantes, couloirs)
    if meilleur is not avant:
        # L'affinage peut ceder quelques metres sur la distance pour gagner
        # sur la repetition ou les crochets : on dit lequel des trois criteres
        # a progresse plutot que la seule distance, qui serait trompeuse.
        journal("  affinage : {:.2f} km -> {:.2f} km, repetition {:.0f} -> "
                "{:.0f} m, crochets {:.2f} -> {:.2f} par km"
                .format((avant[1] + 2 * longueur_amorce) / 1000.0,
                        (meilleur[1] + 2 * longueur_amorce) / 1000.0,
                        avant[2], meilleur[2], avant[0][3], meilleur[0][3]))

    # Meme controle geometrique que pour un parcours d'un point a un autre.
    seuils = seuils_geometriques(cible_m)

    def points_de(essai):
        return allege([coords[n] for n in polyligne_du_trajet(essai[3], aretes)],
                      max_points)

    reserve = [c for c in variantes
               if not (c[1] and c[2] / c[1] > repetition_max)]
    reserve.sort(key=lambda c: c[0])
    choisi, doublement, bouclettes = choisit_trace_propre(
        meilleur, reserve, budget, seuils, points_de, CANDIDATS_EXAMINES)
    annonce_defauts(journal, "boucle", choisi is not meilleur,
                    doublement, bouclettes, seuils)
    meilleur = choisi

    _, longueur, repetee, trajet, nb_sommets, cap, _ = meilleur

    # 5. assemblage du trace ------------------------------------------------
    noeuds = []
    if amorce:
        noeuds.extend(polyligne_du_trajet(amorce, aretes))
    boucle = polyligne_du_trajet(trajet, aretes)
    if noeuds and boucle and noeuds[-1] == boucle[0]:
        noeuds.extend(boucle[1:])
    else:
        noeuds.extend(boucle)
    if amorce:
        retour = list(reversed(polyligne_du_trajet(amorce, aretes)))
        noeuds.extend(retour[1:] if noeuds[-1] == retour[0] else retour)

    points = allege([coords[n] for n in noeuds], max_points)
    distance = longueur + 2 * longueur_amorce
    journal("5/5 Trace retenu : {:.2f} km, {:.0f} m parcourus deux fois{}"
            .format(distance / 1000.0, repetee,
                    ", {:.0f} m longeant une autre portion".format(
                        doublement["longueur"]) if doublement["longueur"] > 0
                    else ""))

    return {
        "points": points,
        "distance": distance,
        "cible": cible_m,
        "repetee": repetee,
        "part_repetee": repetee / longueur if longueur else 0.0,
        "amorce": longueur_amorce,
        "sommets": nb_sommets,
        "cap": cap,
        "accroche": ecart_depart,
        "types": repartition(trajet, aretes, 5),
        "qualites": repartition(trajet, aretes, 6),
        "longueur_boucle": longueur,
        "boucle": True,
        "doublement": doublement["longueur"],
        "portions_doublees": len(doublement["portions"]),
        "bouclettes": bouclettes["longueur"],
        "nb_bouclettes": bouclettes["nombre"],
    }


HOTE = "127.0.0.1"
PORT_DEFAUT = 8765

# La bibliotheque de cartographie est telechargee une seule fois puis servie
# depuis le cache local : les lancements suivants n'attendent plus le CDN.
VERSION_LEAFLET = "1.9.4"
CDN_LEAFLET = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/{}/".format(
    VERSION_LEAFLET)
# chemin servi -> (fichier chez l'editeur, type MIME). Les images sont
# indispensables : la feuille de style les reference en relatif.
RESSOURCES_LEAFLET = {
    "/leaflet.css": ("leaflet.min.css", "text/css; charset=utf-8"),
    "/leaflet.js": ("leaflet.min.js", "application/javascript; charset=utf-8"),
    "/images/marker-icon.png": ("images/marker-icon.png", "image/png"),
    "/images/marker-icon-2x.png": ("images/marker-icon-2x.png", "image/png"),
    "/images/marker-shadow.png": ("images/marker-shadow.png", "image/png"),
    "/images/layers.png": ("images/layers.png", "image/png"),
    "/images/layers-2x.png": ("images/layers-2x.png", "image/png"),
}
LEAFLET_LOCAL = False


def cache_leaflet(relatif):
    return os.path.join(CACHE_DIR, "leaflet-{}-{}".format(
        VERSION_LEAFLET, relatif.replace("/", "-")))


def prepare_leaflet():
    """Met la bibliotheque en cache local. Renvoie False si le telechargement
    echoue : la page se rabat alors sur le CDN."""
    manquants = [r for _, (r, _) in RESSOURCES_LEAFLET.items()
                 if not os.path.exists(cache_leaflet(r))]
    if not manquants:
        return True
    print("  premiere utilisation : mise en cache de la carte ({} fichiers)..."
          .format(len(manquants)))
    os.makedirs(CACHE_DIR, exist_ok=True)
    for relatif in manquants:
        try:
            demande = urllib.request.Request(CDN_LEAFLET + relatif, headers={
                "User-Agent": "generateur-boucle-gpx/2.0 (usage personnel)"})
            with urllib.request.urlopen(demande, timeout=45) as reponse:
                contenu = reponse.read()
            with open(cache_leaflet(relatif), "wb") as fichier:
                fichier.write(contenu)
        except (urllib.error.URLError, OSError) as erreur:
            print("  mise en cache impossible ({}), la carte utilisera le CDN"
                  .format(erreur))
            return False
    return True

# Travaux en cours, indexes par identifiant. Proteges par un verrou : le
# serveur est multi-thread (une requete de suivi arrive pendant le calcul).
TRAVAUX = {}
VERROU = threading.Lock()

# Le serveur tourne tant qu'on veut enchainer plusieurs boucles. Il s'arrete
# par le bouton de la page, par Ctrl+C, ou de lui-meme apres une longue
# inactivite : pas de processus oublie en arriere-plan.
SERVEUR = None
DERNIERE_ACTIVITE = time.monotonic()
INACTIVITE_MAX = 900.0        # 15 minutes


def arrete_serveur():
    """Demande l'arret depuis un autre fil : shutdown() ne peut pas etre
    appele depuis le fil qui traite la requete en cours."""
    if SERVEUR is not None:
        threading.Thread(target=SERVEUR.shutdown, daemon=True).start()


# ---------------------------------------------------------------------------
# Page web
# ---------------------------------------------------------------------------
PAGE = r"""<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Boucle de course - choix du depart</title>
<link rel="preconnect" href="https://tile.openstreetmap.org" crossorigin>
<link rel="dns-prefetch" href="https://tile.openstreetmap.org">
<link rel="stylesheet" href="LEAFLET_CSS">
<style>
  :root {
    --fond: #ffffff; --texte: #16181d; --doux: #667085; --bord: #e3e6ec;
    --accent: #1f6feb; --accent-texte: #ffffff; --ok: #0f7b45; --alerte: #b42318;
    --panneau: rgba(255,255,255,.97);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --fond: #14161a; --texte: #e9ecf1; --doux: #98a2b3; --bord: #2b3038;
      --accent: #4c8dff; --accent-texte: #0b1220; --ok: #3ecf8e; --alerte: #ff7b72;
      --panneau: rgba(20,22,26,.97);
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
          "Helvetica Neue", Arial, sans-serif;
    color: var(--texte); background: var(--fond);
  }
  #carte { position: absolute; inset: 0; background: #e8e4dd; }
  @media (prefers-color-scheme: dark) { #carte { background: #23262b; } }
  /* Rend les tuiles nettes plutot que lissees lors d'un sur-zoom. */
  .leaflet-tile { image-rendering: -webkit-optimize-contrast; }

  #panneau {
    position: absolute; top: 12px; left: 12px; z-index: 1000;
    width: 344px; max-height: calc(100% - 24px); overflow-y: auto;
    background: var(--panneau); border: 1px solid var(--bord);
    border-radius: 12px; padding: 14px;
    box-shadow: 0 8px 28px rgba(0,0,0,.16);
    backdrop-filter: blur(6px);
  }
  h1 { font-size: 15px; margin: 0 0 2px; letter-spacing: -.01em; }
  .sous { color: var(--doux); font-size: 12px; margin: 0 0 12px; }
  label { display: block; font-weight: 600; font-size: 12px; margin: 12px 0 4px; }
  input, select, button {
    font: inherit; width: 100%; padding: 8px 10px;
    border: 1px solid var(--bord); border-radius: 8px;
    background: var(--fond); color: var(--texte);
  }
  input:focus, select:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  button {
    background: var(--accent); color: var(--accent-texte);
    border: none; font-weight: 600; cursor: pointer; padding: 10px;
  }
  button:disabled { opacity: .55; cursor: progress; }
  button.secondaire {
    background: transparent; color: var(--texte); border: 1px solid var(--bord);
    font-weight: 500; padding: 7px;
  }
  .ligne { display: flex; gap: 8px; }
  .ligne > * { flex: 1; }
  .coord {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px;
    background: var(--fond); border: 1px solid var(--bord);
    border-radius: 8px; padding: 8px 10px; margin-top: 4px;
  }
  .coord b { font-weight: 600; }
  .aide { color: var(--doux); font-size: 11.5px; margin-top: 4px; }
  .point { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
  .jeton {
    width: auto; flex: 0 0 auto; padding: 5px 11px; font-size: 12px;
    font-weight: 500; background: transparent; color: var(--texte);
    border: 1px solid var(--bord); cursor: pointer;
  }
  .jeton.actif { border-color: var(--accent); color: var(--accent); font-weight: 700; }
  .coord-ligne {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12.5px;
  }
  .case {
    display: flex; align-items: center; gap: 8px;
    margin: 10px 0 0; font-weight: 600; font-size: 12px; cursor: pointer;
  }
  .case input { width: auto; margin: 0; }
  #resultats { margin-top: 10px; }
  #resultats div {
    padding: 7px 9px; border: 1px solid var(--bord); border-radius: 8px;
    margin-bottom: 4px; cursor: pointer; font-size: 12.5px;
  }
  #resultats div:hover { border-color: var(--accent); }
  #journal {
    display: none; margin-top: 12px; padding: 9px 10px; font-size: 11.5px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    background: var(--fond); border: 1px solid var(--bord); border-radius: 8px;
    max-height: 168px; overflow-y: auto; white-space: pre-wrap; color: var(--doux);
  }
  #barre { display: none; height: 4px; background: var(--bord);
           border-radius: 99px; overflow: hidden; margin-top: 10px; }
  #barre > i { display: block; height: 100%; width: 0; background: var(--accent);
               transition: width .4s ease; }
  #bilan { display: none; margin-top: 12px; }
  #bilan table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  #bilan td { padding: 3px 0; vertical-align: top; }
  #bilan td:first-child { color: var(--doux); padding-right: 10px; white-space: nowrap; }
  #bilan td:last-child { text-align: right; font-variant-numeric: tabular-nums; }
  .titre-bloc { font-weight: 600; font-size: 11px; text-transform: uppercase;
                letter-spacing: .04em; color: var(--doux); margin: 12px 0 4px; }
  .erreur { color: var(--alerte); font-size: 12.5px; margin-top: 10px; }
  .bon { color: var(--ok); }
  .reticule {
    position: absolute; z-index: 900; pointer-events: none;
    left: 50%; top: 50%; width: 1px; height: 1px;
  }
</style>
</head>
<body>
<div id="carte"></div>

<div id="panneau">
  <h1>Ou pars-tu ?</h1>
  <p class="sous">Clique sur la carte, ou fais glisser le marqueur. Zoome a fond
     pour le poser au bon endroit.</p>

  <label for="q">Chercher une adresse</label>
  <div class="ligne">
    <input id="q" placeholder="ville, rue, lieu-dit..." autocomplete="off">
    <button class="secondaire" id="btn-position" style="flex:0 0 auto;width:auto"
            title="Utiliser ma position">Ma position</button>
  </div>
  <div id="resultats"></div>

  <label>Points du parcours</label>
  <div class="point">
    <button class="jeton actif" id="jeton-depart" type="button">Depart</button>
    <span class="coord-ligne"><b id="lat">--</b>, <b id="lon">--</b></span>
  </div>
  <div class="point" id="bloc-arrivee" hidden>
    <button class="jeton" id="jeton-arrivee" type="button">Arrivee</button>
    <span class="coord-ligne"><b id="lat2">--</b>, <b id="lon2">--</b></span>
  </div>
  <label class="case">
    <input type="checkbox" id="case-arrivee">
    Arrivee differente du depart
  </label>
  <p class="aide" id="precision"></p>

  <label for="km">Distance souhaitee</label>
  <div class="ligne">
    <input id="km" type="number" min="1" max="150" step="0.1" value="7">
    <input id="curseur" type="range" min="1" max="80" step="0.5" value="7"
           style="padding:0">
  </div>
  <p class="aide">Une tolerance de 3 % est admise : entre deux boucles, celle qui
     ne se repete pas l'emporte sur celle qui tombe pile.</p>

  <label for="niveau">Exigence de praticabilite</label>
  <select id="niveau">
    <option value="strict">Stricte - bitume et stabilise uniquement</option>
    <option value="normal" selected>Normale - chemins documentes et balises</option>
    <option value="tolerant">Tolerante - accepte les sentiers non documentes</option>
  </select>

  <label for="fichier">Nom du fichier GPX</label>
  <input id="fichier" placeholder="date et distance (automatique)">
  <p class="aide">Laisse vide : le fichier sera nomme par sa date et sa
     distance, donc unique et classe dans l'ordre chronologique.</p>

  <button id="btn-generer" style="margin-top:14px">Generer le parcours</button>
  <div id="barre"><i></i></div>
  <div id="journal"></div>
  <div id="bilan"></div>
  <div id="message"></div>
  <button id="btn-arreter" class="secondaire" style="margin-top:10px">
    Terminer et fermer le serveur</button>
</div>

<script src="LEAFLET_JS"></script>
<script>
const CONFIG = /*CONFIG*/;

// Le dernier depart, la derniere distance et le dernier niveau sont retenus
// par le navigateur, sur ce poste uniquement. Rien de personnel n'est ecrit
// dans le code : le fichier peut etre partage tel quel.
const MEMOIRE = "generateur-boucle:reglages";
function litMemoire() {
  try { return JSON.parse(localStorage.getItem(MEMOIRE) || "null") || {}; }
  catch (e) { return {}; }
}
function ecritMemoire(modifs) {
  try {
    localStorage.setItem(MEMOIRE, JSON.stringify(
      Object.assign(litMemoire(), modifs)));
  } catch (e) { /* navigation privee : on s'en passe */ }
}
const memoire = litMemoire();
const departConnu = typeof memoire.lat === "number" && typeof memoire.lon === "number";

const bouton = document.getElementById("btn-generer");
const journal = document.getElementById("journal");
const barre = document.getElementById("barre");
const bilan = document.getElementById("bilan");
const message = document.getElementById("message");
const champKm = document.getElementById("km");
const curseur = document.getElementById("curseur");
const champNiveau = document.getElementById("niveau");

// --- fonds de carte -------------------------------------------------------
// Ordonnes du plus rapide au plus lent. maxNativeZoom = dernier niveau
// reellement rendu par le serveur ; au-dela Leaflet agrandit la derniere
// tuile nette plutot que d'afficher un carre gris.
// keepBuffer reduit les tuiles chargees hors ecran : moins d'attente.
const communs = { keepBuffer: 1, updateWhenZooming: false, maxZoom: 21 };
const fonds = {
  "Plan": L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    Object.assign({ maxNativeZoom: 19,
      attribution: '&copy; OpenStreetMap' }, communs)),
  "Plan detaille (plus lent)": L.tileLayer(
    "https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png",
    Object.assign({ maxNativeZoom: 20, subdomains: "abc",
      attribution: '&copy; OpenStreetMap France' }, communs)),
  "Satellite": L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    Object.assign({ maxNativeZoom: 19,
      attribution: 'Imagerie &copy; Esri, Maxar' }, communs)),
  "Relief": L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    Object.assign({ maxNativeZoom: 17, subdomains: "abc",
      attribution: '&copy; OpenTopoMap, &copy; OpenStreetMap' }, communs)),
};

const carte = L.map("carte", {
  // Sans depart memorise, on ouvre sur la France entiere : quelques tuiles
  // suffisent, l'affichage est immediat.
  center: departConnu ? [memoire.lat, memoire.lon] : [46.7, 2.4],
  zoom: departConnu ? (memoire.zoom || 16) : 5,
  layers: [fonds["Plan"]],
  preferCanvas: true,
});
L.control.layers(fonds, {}, { position: "topright" }).addTo(carte);
L.control.scale({ imperial: false, position: "bottomleft" }).addTo(carte);

// --- points de depart et d'arrivee ---------------------------------------
const jetonDepart = document.getElementById("jeton-depart");
const jetonArrivee = document.getElementById("jeton-arrivee");
const caseArrivee = document.getElementById("case-arrivee");
const blocArrivee = document.getElementById("bloc-arrivee");

let marqueur = null;          // depart
let marqueurArrivee = null;   // arrivee, seulement si la case est cochee
let trace = null;
let aPoser = "depart";        // ce que le prochain clic sur la carte posera

function icone(lettre, couleur) {
  return L.divIcon({
    className: "",
    html: '<div style="width:26px;height:26px;border-radius:50%;background:'
      + couleur + ';color:#fff;font:700 13px/24px system-ui,sans-serif;'
      + 'text-align:center;border:2px solid #fff;'
      + 'box-shadow:0 1px 5px rgba(0,0,0,.45)">' + lettre + "</div>",
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
  document.getElementById("lat").textContent = d ? d.lat.toFixed(6) : "--";
  document.getElementById("lon").textContent = d ? d.lng.toFixed(6) : "--";
  document.getElementById("lat2").textContent = a ? a.lat.toFixed(6) : "--";
  document.getElementById("lon2").textContent = a ? a.lng.toFixed(6) : "--";

  const manqueArrivee = caseArrivee.checked && !a;
  document.getElementById("precision").textContent = !d
    ? "Clique sur la carte pour poser le depart."
    : manqueArrivee ? "Clique sur la carte pour poser l'arrivee."
    : (carte.getZoom() >= 17 ? "" : "Zoome pour affiner la position.");
  bouton.disabled = !d || manqueArrivee;

  if (enregistre) {
    ecritMemoire({
      lat: d ? d.lat : null, lon: d ? d.lng : null, zoom: carte.getZoom(),
      arrivee: a ? { lat: a.lat, lon: a.lng } : null,
      arriveeActive: caseArrivee.checked,
    });
  }
}

function poseDepart(latlng, recentre) {
  if (marqueur) {
    marqueur.setLatLng(latlng);
  } else {
    marqueur = L.marker(latlng, { draggable: true, autoPan: true,
                                  icon: icone("D", "#1f7a3d"), title: "Depart" })
                .addTo(carte);
    marqueur.on("drag move", () => majCoord(true));
  }
  if (recentre) carte.setView(latlng, Math.max(carte.getZoom(), 17));
  majCoord(true);
}

function poseArrivee(latlng, recentre) {
  if (marqueurArrivee) {
    marqueurArrivee.setLatLng(latlng);
  } else {
    marqueurArrivee = L.marker(latlng, { draggable: true, autoPan: true,
                                         icon: icone("A", "#b42318"),
                                         title: "Arrivee" }).addTo(carte);
    marqueurArrivee.on("drag move", () => majCoord(true));
  }
  if (recentre) carte.setView(latlng, Math.max(carte.getZoom(), 17));
  majCoord(true);
}

function pose(latlng, recentre) {
  if (aPoser === "arrivee" && caseArrivee.checked) poseArrivee(latlng, recentre);
  else poseDepart(latlng, recentre);
  // Une fois le depart pose, le clic suivant vise naturellement l'arrivee.
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

if (memoire.arriveeActive) {
  caseArrivee.checked = true;
  blocArrivee.hidden = false;
}
if (departConnu) poseDepart(L.latLng(memoire.lat, memoire.lon), false);
if (caseArrivee.checked && memoire.arrivee) {
  poseArrivee(L.latLng(memoire.arrivee.lat, memoire.arrivee.lon), false);
}
aPoser = (caseArrivee.checked && !marqueurArrivee) ? "arrivee" : "depart";
majJetons();
majCoord(false);

carte.on("click", (e) => pose(e.latlng, false));
carte.on("zoomend", () => majCoord(false));

document.getElementById("btn-position").onclick = () => {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => pose(L.latLng(pos.coords.latitude, pos.coords.longitude), true),
    () => afficheErreur("Position indisponible (autorisation refusee ?)."),
    { enableHighAccuracy: true });
};

// --- recherche d'adresse --------------------------------------------------
const champQ = document.getElementById("q");
const zoneResultats = document.getElementById("resultats");
let minuteur = null;

champQ.addEventListener("input", () => {
  clearTimeout(minuteur);
  const q = champQ.value.trim();
  if (q.length < 3) { zoneResultats.innerHTML = ""; return; }
  minuteur = setTimeout(async () => {
    try {
      const r = await fetch("/adresse?q=" + encodeURIComponent(q));
      const lieux = await r.json();
      zoneResultats.innerHTML = "";
      lieux.slice(0, 5).forEach((lieu) => {
        const d = document.createElement("div");
        d.textContent = lieu.display_name;
        d.onclick = () => {
          pose(L.latLng(parseFloat(lieu.lat), parseFloat(lieu.lon)), true);
          zoneResultats.innerHTML = ""; champQ.value = "";
        };
        zoneResultats.appendChild(d);
      });
    } catch (e) { /* recherche indisponible : on laisse la carte a la souris */ }
  }, 450);
});

// --- distance et exigence, retenues d'une fois sur l'autre ----------------
if (memoire.km) { champKm.value = memoire.km; curseur.value = memoire.km; }
if (memoire.niveau) champNiveau.value = memoire.niveau;
champKm.addEventListener("input", () => {
  curseur.value = champKm.value; ecritMemoire({ km: champKm.value });
});
curseur.addEventListener("input", () => {
  champKm.value = curseur.value; ecritMemoire({ km: curseur.value });
});
champNiveau.addEventListener("change",
  () => ecritMemoire({ niveau: champNiveau.value }));

// --- generation -----------------------------------------------------------
function afficheErreur(texte) {
  message.innerHTML = '<p class="erreur">' + texte + "</p>";
}

bouton.onclick = async () => {
  if (!marqueur) { afficheErreur("Pose d'abord ton depart sur la carte."); return; }
  const p = marqueur.getLatLng();
  const arrivee = (caseArrivee.checked && marqueurArrivee)
    ? marqueurArrivee.getLatLng() : null;
  if (caseArrivee.checked && !arrivee) {
    afficheErreur("Pose l'arrivee sur la carte."); return;
  }
  const km = parseFloat(champKm.value);
  if (!(km > 0)) { afficheErreur("Distance invalide."); return; }

  bouton.disabled = true;
  bouton.textContent = "Recherche en cours...";
  journal.style.display = "block"; journal.textContent = "";
  barre.style.display = "block"; barre.firstElementChild.style.width = "0";
  bilan.style.display = "none"; message.innerHTML = "";
  if (trace) { carte.removeLayer(trace); trace = null; }

  let id;
  try {
    const r = await fetch("/generer", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lat: p.lat, lon: p.lng, km: km,
        arrivee_lat: arrivee ? arrivee.lat : null,
        arrivee_lon: arrivee ? arrivee.lng : null,
        niveau: champNiveau.value,
        fichier: document.getElementById("fichier").value,
      }),
    });
    id = (await r.json()).id;
  } catch (e) {
    finGeneration();
    afficheErreur("Serveur injoignable : il s'est sans doute arrete apres une "
      + "longue inactivite. Relance le script.");
    return;
  }

  const debut = Date.now();
  const suivi = setInterval(async () => {
    let etat;
    try { etat = await (await fetch("/etat?id=" + id)).json(); }
    catch (e) { return; }

    journal.textContent = etat.lignes.join("\n");
    journal.scrollTop = journal.scrollHeight;
    const faits = etat.lignes.filter((l) => l.startsWith("  cap")).length;
    const part = Math.min(96, 8 + (faits / etat.caps) * 88);
    barre.firstElementChild.style.width = part + "%";
    const secondes = Math.round((Date.now() - debut) / 1000);
    bouton.textContent = "Recherche en cours... " + secondes + " s";

    if (!etat.termine) return;
    clearInterval(suivi);
    finGeneration();
    if (etat.erreur) { afficheErreur(etat.erreur); return; }
    barre.firstElementChild.style.width = "100%";
    dessine(etat.resultat, id);
  }, 1000);
};

function finGeneration() {
  bouton.textContent = "Generer le parcours";
  majCoord(false);
}

document.getElementById("btn-arreter").onclick = async () => {
  try { await fetch("/arreter", { method: "POST" }); } catch (e) { /* deja parti */ }
  document.title = "Serveur arrete";
  document.body.innerHTML = '<div style="padding:48px;max-width:34em;'
    + 'font:15px/1.6 system-ui,sans-serif">'
    + "<h1 style=\"font-size:17px\">Serveur arrete</h1>"
    + "<p>Tes fichiers GPX sont dans le dossier du script. "
    + "Tu peux fermer cet onglet.</p></div>";
};

function dessine(r, id) {
  trace = L.polyline(r.points, { color: "#e8590c", weight: 4.5, opacity: .92 })
           .addTo(carte);
  carte.fitBounds(trace.getBounds(), { padding: [40, 40] });

  const km = (m) => (m / 1000).toFixed(2) + " km";
  const pct = (m) => " (" + (m / r.longueur_boucle * 100).toFixed(0) + " %)";
  let html = '<div class="titre-bloc">Boucle retenue</div><table>';
  html += "<tr><td>Distance</td><td><b>" + km(r.distance) + "</b> ("
        + (r.distance - r.cible >= 0 ? "+" : "")
        + Math.round(r.distance - r.cible) + " m)</td></tr>";
  const propre = r.repetee < 1;
  html += "<tr><td>Aller-retour</td><td class="
        + (propre ? '"bon"' : '""') + ">"
        + (propre ? "aucun" : Math.round(r.repetee) + " m") + "</td></tr>";
  html += "<tr><td>Depart a</td><td>" + Math.round(r.accroche)
        + " m du point pose</td></tr>";
  html += "</table>";

  html += '<div class="titre-bloc">Praticabilite verifiee</div><table>';
  r.qualites.forEach(([q, m]) => {
    html += "<tr><td>" + q + "</td><td>" + km(m) + pct(m) + "</td></tr>";
  });
  html += "</table>";

  html += '<div class="titre-bloc">Type de voie</div><table>';
  r.types.forEach(([t, m]) => {
    html += "<tr><td>" + t + "</td><td>" + km(m) + pct(m) + "</td></tr>";
  });
  html += "</table>";

  html += '<p class="aide">Enregistre dans <b>' + r.fichier + "</b></p>";
  html += '<a href="/gpx?id=' + id + '" download><button class="secondaire" '
        + 'style="margin-top:6px">Telecharger le GPX</button></a>';
  bilan.innerHTML = html;
  bilan.style.display = "block";
}
</script>
</body>
</html>
"""


# ---------------------------------------------------------------------------
# Serveur
# ---------------------------------------------------------------------------
def lance_generation(identifiant, parametres):
    """Execute la recherche dans un fil separe et consigne l'avancement."""
    travail = TRAVAUX[identifiant]

    def journal(ligne):
        with VERROU:
            travail["lignes"].append(str(ligne))

    try:
        resultat = genere(
            parametres["lat"], parametres["lon"], parametres["km"] * 1000.0,
            niveau=parametres["niveau"], journal=journal,
            arrivee=parametres.get("arrivee"),
        )
        nom_fichier = parametres["fichier"].strip() or nom_horodate(parametres["km"])
        if not nom_fichier.lower().endswith(".gpx"):
            nom_fichier += ".gpx"
        nom_fichier = os.path.basename(nom_fichier)
        chemin = chemin_disponible(os.path.join(SCRIPT_DIR, nom_fichier))
        nom = nom_trace(parametres["km"], parametres.get("arrivee") is None)
        ecrit_gpx(resultat["points"], nom, chemin)

        with VERROU:
            travail["chemin"] = chemin
            travail["resultat"] = {
                "points": [[lat, lon] for lat, lon in resultat["points"]],
                "distance": resultat["distance"],
                "cible": resultat["cible"],
                "repetee": resultat["repetee"],
                "accroche": resultat["accroche"],
                "longueur_boucle": resultat["longueur_boucle"],
                "types": [[t, m] for t, m in resultat["types"]],
                "qualites": [[LIBELLES_QUALITE.get(q, q), m]
                             for q, m in resultat["qualites"]],
                "fichier": os.path.basename(chemin),
                "boucle": resultat.get("boucle", True),
            }
    except (BoucleIntrouvable, DonneesIndisponibles) as erreur:
        with VERROU:
            travail["erreur"] = str(erreur)
    except Exception as erreur:                     # pragma: no cover
        with VERROU:
            travail["erreur"] = "Erreur inattendue : {}".format(erreur)
    finally:
        with VERROU:
            travail["termine"] = True


class Serveur(http.server.BaseHTTPRequestHandler):
    server_version = "carte-boucle/1.0"

    def log_message(self, *args):
        pass                                        # journal HTTP silencieux

    # -- utilitaires -------------------------------------------------------
    def repond(self, contenu, type_mime="application/json; charset=utf-8",
               code=200, entetes=()):
        if isinstance(contenu, str):
            contenu = contenu.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", type_mime)
        self.send_header("Content-Length", str(len(contenu)))
        for cle, valeur in entetes:
            self.send_header(cle, valeur)
        self.end_headers()
        self.wfile.write(contenu)

    def json(self, donnees, code=200):
        self.repond(json.dumps(donnees), code=code)

    # -- routes ------------------------------------------------------------
    def do_GET(self):
        global DERNIERE_ACTIVITE
        DERNIERE_ACTIVITE = time.monotonic()
        chemin = urllib.parse.urlparse(self.path)
        parametres = urllib.parse.parse_qs(chemin.query)

        if chemin.path == "/":
            base = "/" if LEAFLET_LOCAL else CDN_LEAFLET
            page = (PAGE
                    .replace("/*CONFIG*/", json.dumps({"km": DEFAUT_KM}))
                    .replace("LEAFLET_CSS", base + ("leaflet.css"
                             if LEAFLET_LOCAL else "leaflet.min.css"))
                    .replace("LEAFLET_JS", base + ("leaflet.js"
                             if LEAFLET_LOCAL else "leaflet.min.js")))
            self.repond(page, "text/html; charset=utf-8")

        elif chemin.path in RESSOURCES_LEAFLET and LEAFLET_LOCAL:
            relatif, type_mime = RESSOURCES_LEAFLET[chemin.path]
            try:
                with open(cache_leaflet(relatif), "rb") as fichier:
                    contenu = fichier.read()
            except OSError:
                self.json({"erreur": "ressource absente"}, 404)
                return
            # Ressources versionnees et immuables : le navigateur peut les
            # garder, la carte se rouvre alors instantanement.
            self.repond(contenu, type_mime,
                        entetes=(("Cache-Control", "public, max-age=31536000, immutable"),))

        elif chemin.path == "/adresse":
            self.cherche_adresse(parametres.get("q", [""])[0])

        elif chemin.path == "/etat":
            identifiant = parametres.get("id", [""])[0]
            with VERROU:
                travail = TRAVAUX.get(identifiant)
                if travail is None:
                    self.json({"erreur": "travail inconnu", "termine": True,
                               "lignes": [], "caps": 8}, 404)
                    return
                self.json({
                    "lignes": list(travail["lignes"]),
                    "termine": travail["termine"],
                    "erreur": travail["erreur"],
                    "resultat": travail["resultat"],
                    "caps": travail["caps"],
                })

        elif chemin.path == "/gpx":
            self.envoie_gpx(parametres.get("id", [""])[0])

        else:
            self.json({"erreur": "inconnu"}, 404)

    def do_POST(self):
        global DERNIERE_ACTIVITE
        DERNIERE_ACTIVITE = time.monotonic()
        chemin = urllib.parse.urlparse(self.path).path
        if chemin == "/arreter":
            self.json({"arret": True})
            print("\nArret demande depuis la page.")
            arrete_serveur()
            return
        if chemin != "/generer":
            self.json({"erreur": "inconnu"}, 404)
            return
        taille = int(self.headers.get("Content-Length") or 0)
        try:
            parametres = json.loads(self.rfile.read(taille).decode("utf-8"))
            lat = float(parametres["lat"])
            lon = float(parametres["lon"])
            km = float(parametres["km"])
        except (ValueError, KeyError, TypeError):
            self.json({"erreur": "parametres invalides"}, 400)
            return
        if not (0 < km <= 150) or not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
            self.json({"erreur": "parametres hors limites"}, 400)
            return

        arrivee = None
        if parametres.get("arrivee_lat") is not None \
                and parametres.get("arrivee_lon") is not None:
            try:
                arrivee = (float(parametres["arrivee_lat"]),
                           float(parametres["arrivee_lon"]))
            except (TypeError, ValueError):
                self.json({"erreur": "arrivee invalide"}, 400)
                return
            if not (-90 <= arrivee[0] <= 90) or not (-180 <= arrivee[1] <= 180):
                self.json({"erreur": "arrivee hors limites"}, 400)
                return

        identifiant = uuid.uuid4().hex[:12]
        with VERROU:
            TRAVAUX[identifiant] = {
                "lignes": [], "termine": False, "erreur": None,
                "resultat": None, "chemin": None, "caps": 8,
            }
        niveau = parametres.get("niveau", "normal")
        if niveau not in ("strict", "normal", "tolerant"):
            niveau = "normal"
        travail = {"lat": lat, "lon": lon, "km": km, "niveau": niveau,
                   "arrivee": arrivee,
                   "fichier": str(parametres.get("fichier", ""))}
        threading.Thread(target=lance_generation, args=(identifiant, travail),
                         daemon=True).start()
        print("  demande : {:.6f}, {:.6f} sur {:.1f} km ({})"
              .format(lat, lon, km, niveau))
        self.json({"id": identifiant})

    # -- services ----------------------------------------------------------
    def cherche_adresse(self, question):
        """Relais vers Nominatim, avec un en-tete d'identification correct."""
        if len(question) < 3:
            self.json([])
            return
        url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(
            {"q": question, "format": "json", "limit": 5, "accept-language": "fr"})
        demande = urllib.request.Request(url, headers={
            "User-Agent": "generateur-boucle-gpx/2.0 (usage personnel)",
            "Accept": "application/json",
        })
        try:
            with urllib.request.urlopen(demande, timeout=12) as reponse:
                self.repond(reponse.read())
        except (urllib.error.URLError, OSError):
            self.json([])

    def envoie_gpx(self, identifiant):
        with VERROU:
            travail = TRAVAUX.get(identifiant)
            chemin = travail and travail.get("chemin")
        # On ne sert que le fichier produit par ce travail, jamais un chemin
        # fourni par le client.
        if not chemin or not os.path.isfile(chemin):
            self.json({"erreur": "fichier introuvable"}, 404)
            return
        with open(chemin, "rb") as fichier:
            contenu = fichier.read()
        self.repond(contenu, "application/gpx+xml", entetes=(
            ("Content-Disposition",
             'attachment; filename="{}"'.format(os.path.basename(chemin))),))


def port_libre(depart):
    for port in range(depart, depart + 40):
        with socket.socket() as prise:
            try:
                prise.bind((HOTE, port))
                return port
            except OSError:
                continue
    raise SystemExit("Aucun port libre entre {} et {}.".format(depart, depart + 40))


def surveille_inactivite():
    """Coupe le serveur s'il n'a rien a faire depuis un long moment : sans
    cela, un script lance puis oublie resterait indefiniment en fond."""
    while True:
        time.sleep(30)
        with VERROU:
            occupe = any(not travail["termine"] for travail in TRAVAUX.values())
        if occupe:
            continue
        if time.monotonic() - DERNIERE_ACTIVITE > INACTIVITE_MAX:
            print("\nAucune activite depuis {:.0f} minutes : arret automatique."
                  .format(INACTIVITE_MAX / 60))
            arrete_serveur()
            return


def demarre(port=PORT_DEFAUT, ouvre_navigateur=True):
    global LEAFLET_LOCAL, SERVEUR, DERNIERE_ACTIVITE
    LEAFLET_LOCAL = prepare_leaflet()
    port = port_libre(port)
    adresse = "http://{}:{}/".format(HOTE, port)
    serveur = http.server.ThreadingHTTPServer((HOTE, port), Serveur)
    SERVEUR = serveur
    DERNIERE_ACTIVITE = time.monotonic()
    threading.Thread(target=surveille_inactivite, daemon=True).start()

    print("Carte prete : {}".format(adresse))
    print("Pose ton depart a la souris, choisis la distance, lance la recherche.")
    print("Les GPX sont enregistres dans {}".format(SCRIPT_DIR))
    print("Pour rendre la main : bouton \"Terminer\" sur la page, Ctrl+C, ou "
          "arret automatique apres {:.0f} min d'inactivite.\n"
          .format(INACTIVITE_MAX / 60))

    def ouvre():
        # webbrowser s'en remet au navigateur par defaut du systeme (variable
        # BROWSER, puis xdg-open sous Linux, open sous macOS, le navigateur
        # associe sous Windows) : Firefox, Chrome, Opera, Edge... peu importe.
        if not webbrowser.open(adresse, new=2):
            print("Aucun navigateur n'a pu etre lance automatiquement.")
            print("Ouvre cette adresse a la main : {}".format(adresse))

    if ouvre_navigateur:
        threading.Timer(0.6, ouvre).start()
    try:
        serveur.serve_forever()
    except KeyboardInterrupt:
        print("\nArret.")
    finally:
        serveur.server_close()
    print("Serveur arrete.")
    return 0


DRAPEAUX_CARTE = {"--carte", "--port", "--pas-de-navigateur"}


def mode_carte(arguments):
    """Sans argument, on ouvre la carte : c'est l'usage courant. Des qu'un
    parametre de generation est fourni, on reste en ligne de commande."""
    options = [a.split("=")[0] for a in arguments if a.startswith("-")]
    if "--carte" in options:
        return True
    return all(option in DRAPEAUX_CARTE for option in options)


def main():
    parseur = argparse.ArgumentParser(
        description="Genere une boucle GPX sur chemins verifies praticables.")
    parseur.add_argument("--lat", type=float, default=None,
                         help="latitude du depart (aucune valeur par defaut)")
    parseur.add_argument("--lon", type=float, default=None,
                         help="longitude du depart (aucune valeur par defaut)")
    parseur.add_argument("--arrivee-lat", type=float, default=None,
                         help="latitude d'une arrivee differente du depart")
    parseur.add_argument("--arrivee-lon", type=float, default=None,
                         help="longitude d'une arrivee differente du depart")
    parseur.add_argument("--km", type=float, default=DEFAUT_KM)
    parseur.add_argument("--sortie", default=None,
                         help="par defaut : un nom horodate du type "
                              "2026-09-09_18h45_7.0km.gpx")
    parseur.add_argument("--nom", default=None)
    parseur.add_argument("--niveau", choices=("strict", "normal", "tolerant"),
                         default="normal",
                         help="exigence de praticabilite : strict = revetement "
                              "dur uniquement, normal = defaut, tolerant = "
                              "accepte les sentiers de revetement inconnu")
    parseur.add_argument("--caps", type=int, default=16,
                         help="nombre d'orientations de depart testees")
    parseur.add_argument("--sommets", type=int, nargs="+", default=(3, 4, 5, 6),
                         help="nombres d'ancres de la boucle a essayer")
    parseur.add_argument("--iterations", type=int, default=10,
                         help="etapes de dichotomie par combinaison")
    parseur.add_argument("--repetition-max", type=float, default=0.12,
                         help="part maximale de la boucle parcourue deux fois")
    parseur.add_argument("--tolerance", type=float, default=0.03,
                         help="ecart de distance juge acceptable (0.03 = 3 %%) ; "
                              "en deca, on privilegie la boucle qui se repete "
                              "le moins plutot que la distance au metre pres")
    parseur.add_argument("--max-points", type=int, default=3000)
    parseur.add_argument("--geojson", action="store_true",
                         help="ecrit aussi un .geojson visualisable sur geojson.io")
    parseur.add_argument("--rafraichir", action="store_true",
                         help="ignore le cache et retelecharge le reseau OSM")
    parseur.add_argument("--carte", action="store_true",
                         help="ouvre la carte interactive dans le navigateur "
                              "(comportement par defaut sans argument)")
    parseur.add_argument("--port", type=int, default=PORT_DEFAUT,
                         help="port du serveur local de la carte")
    parseur.add_argument("--pas-de-navigateur", action="store_true",
                         help="avec --carte : ne pas ouvrir le navigateur, "
                              "afficher seulement l'adresse a coller")
    args = parseur.parse_args()

    if mode_carte(sys.argv[1:]):
        return demarre(args.port, not args.pas_de_navigateur)

    if args.lat is None or args.lon is None:
        parseur.error("precise --lat et --lon, ou lance le script sans "
                      "argument pour poser le depart sur la carte")
    if (args.arrivee_lat is None) != (args.arrivee_lon is None):
        parseur.error("--arrivee-lat et --arrivee-lon vont par paire")
    arrivee = (None if args.arrivee_lat is None
               else (args.arrivee_lat, args.arrivee_lon))

    if args.sortie is None:
        args.sortie = nom_horodate(args.km)
    if not os.path.isabs(args.sortie):
        args.sortie = os.path.join(SCRIPT_DIR, args.sortie)

    cible = args.km * 1000.0
    nom = args.nom or nom_trace(args.km, arrivee is None)

    print("Depart      : {:.6f}, {:.6f}".format(args.lat, args.lon))
    if arrivee is not None:
        print("Arrivee     : {:.6f}, {:.6f}".format(*arrivee))
    print("Cible       : {:.2f} km".format(args.km))
    print("Exigence    : praticabilite {}\n".format(args.niveau))

    try:
        resultat = genere(
            args.lat, args.lon, cible, niveau=args.niveau, caps=args.caps,
            sommets=tuple(args.sommets), iterations=args.iterations,
            tolerance=args.tolerance, repetition_max=args.repetition_max,
            max_points=args.max_points, rafraichir=args.rafraichir,
            arrivee=arrivee,
        )
    except (BoucleIntrouvable, DonneesIndisponibles) as erreur:
        print("\nEchec : {}".format(erreur))
        return 1

    points = resultat["points"]
    longueur = resultat["longueur_boucle"]
    sortie = chemin_disponible(args.sortie)
    ecrit_gpx(points, nom, sortie)

    print("\nResultat")
    print("  Distance   : {:.2f} km ({:+.0f} m par rapport a la cible)"
          .format(resultat["distance"] / 1000.0, resultat["distance"] - cible))
    if resultat.get("boucle", True):
        print("  Forme      : {} ancres, orientation {:.0f} deg"
              .format(resultat["sommets"], resultat["cap"]))
    else:
        print("  Forme      : parcours par {} point(s) de passage"
              .format(resultat["sommets"]))
    print("  Repetition : {:.0f} m parcourus deux fois ({:.1f} % du trace)"
          .format(resultat["repetee"], resultat["part_repetee"] * 100))
    print("  Type de voie :")
    for etiquette, metres in resultat["types"]:
        print("    {:<14} {:5.2f} km ({:4.1f} %)"
              .format(etiquette, metres / 1000.0, metres / longueur * 100))
    print("  Praticabilite verifiee :")
    for qualite, metres in resultat["qualites"]:
        print("    {:<24} {:5.2f} km ({:4.1f} %)"
              .format(LIBELLES_QUALITE.get(qualite, qualite), metres / 1000.0,
                      metres / longueur * 100))
    print("  Points     : {}".format(len(points)))
    print("  Fichier    : {}".format(sortie))

    if args.geojson:
        apercu = sortie.rsplit(".", 1)[0] + ".geojson"
        ecrit_geojson(points, apercu)
        print("  Apercu     : {} (glisser sur geojson.io)".format(apercu))

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nInterrompu.")
        sys.exit(1)
