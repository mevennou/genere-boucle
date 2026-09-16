# genere-boucle

Génère une boucle de course à pied d'une distance donnée, départ et arrivée au même point, en n'empruntant **que** des voies que les données OpenStreetMap décrivent comme praticables à pied. Le filtrage porte sur les données, pas sur le terrain : une carte peut être incomplète ou datée, l'itinéraire reste à vérifier avant de le courir.

Deux façons de s'en servir, le même algorithme derrière :

- **[Le site](https://mevennou.github.io/genere-boucle/)** — rien à installer, rien à créer. Tout le calcul se fait dans votre navigateur.
- **Le script Python** — un seul fichier, aucune dépendance, pour ceux qui préfèrent la ligne de commande ou travailler hors ligne.

Sortie en GPX standard, importable dans COROS, Garmin, Suunto, Strava, Komoot…

![Tests](https://github.com/mevennou/genere-boucle/actions/workflows/tests.yml/badge.svg)
![Licence MIT](https://img.shields.io/badge/licence-MIT-green)

## Le principe

Ce n'est pas un simple appel à un serveur de routage.

1. Le réseau OpenStreetMap réel autour du départ est téléchargé via Overpass.
2. Le graphe piétonnier est **construit ici**, et n'accueille que les voies dont les tags OSM attestent la praticabilité. Un sentier broussailleux, une trace informelle, un gué, une voie privée n'existent tout simplement pas dans le graphe : l'itinéraire ne peut pas y passer. C'est une garantie structurelle, pas une pénalité qu'une bonne distance pourrait compenser.
3. Toutes les impasses sont supprimées (réduction dite « 2-cœur » : retrait itératif des nœuds n'ayant qu'un seul voisin). Plus d'antenne sans issue, donc plus d'aller-retour ni de demi-tour.
4. La boucle est cherchée par un polygone d'ancres (3 à 6 sommets) autour du départ, chaque tronçon calculé en A\* avec une forte pénalité sur les arêtes déjà empruntées : la distance cible est atteinte en **élargissant** la boucle, jamais en ajoutant des va-et-vient.
5. Une rue et son trottoir cartographié à part sont deux arêtes distinctes du graphe, mais une seule voie sur le terrain : elles sont regroupées en **couloirs**, pour qu'aller par l'une et revenir par l'autre compte comme un aller-retour. Le tracé retenu subit enfin un contrôle géométrique, qui mesure la longueur longeant une autre portion du parcours et écarte le candidat au profit du suivant si besoin.

## Le site

Hébergé sur GitHub Pages, donc statique : il n'y a aucun serveur de calcul. Le navigateur télécharge le réseau OSM, construit le graphe et cherche la boucle sur la machine du visiteur, dans un *web worker* pour que la carte reste manipulable pendant la recherche. Conséquence heureuse : la charge reste diffuse sur les serveurs bénévoles d'OpenStreetMap, puisque chaque visiteur interroge Overpass depuis chez lui.

Le portage JavaScript est environ **neuf fois plus rapide** que la version Python à résultat identique, parce qu'il travaille sur des indices denses et des tableaux typés plutôt que sur des tables de hachage indexées par identifiants OSM, et qu'il réutilise ses tableaux de travail d'un appel d'A\* au suivant.

L'interface s'adapte au téléphone : le panneau devient une feuille que l'on replie d'un geste pour dégager la carte, les commandes de zoom sont placées à l'opposé et dimensionnées pour le pouce, et le parcours généré replie automatiquement la feuille.

Navigateur requis : un navigateur à jour, les modules ES dans les workers étant nécessaires.

### Déployer sa propre copie

Dans le dépôt : Settings → Pages → Source → **GitHub Actions**. C'est tout : le workflow `deploiement.yml` téléverse `docs/` tel quel à chaque `git push` sur `main`.

Évitez l'ancienne option « Deploy from a branch » : elle fait tourner Jekyll sur le dossier source, ce qui n'a pas lieu d'être pour un site déjà statique et provoque des erreurs de construction. Si vous y tenez malgré tout, le fichier `docs/.nojekyll` doit impérativement être présent dans le dépôt.

Le dossier `docs/` est autonome : aucun CDN, aucune police externe, aucune clé d'API. Leaflet y est vendorisé, avec sa licence BSD-2-Clause.

## Le script Python

Aucune installation. Il faut Python 3 (déjà présent sur macOS et Linux ; sur Windows, [python.org](https://www.python.org/downloads/)).

```bash
python genere_boucle.py                                  # la carte s'ouvre
python genere_boucle.py --lat 48.85 --lon 2.35 --km 10
python genere_boucle.py --lat 48.85 --lon 2.35 --km 21.1 --niveau strict
```

Sans argument, une carte s'ouvre sur `http://127.0.0.1:8765/` : on y pose son départ à la souris. Le serveur est purement local et s'arrête seul après 15 minutes d'inactivité. Les fichiers produits portent leur date et leur distance (`2026-09-09_18h45_7.0km.gpx`).

`python genere_boucle.py --help` liste toutes les options : arrivée différente du départ, tolérance, part maximale répétée, nombre d'orientations testées, export GeoJSON, rafraîchissement du cache.

### Niveaux d'exigence

| Niveau | Ce qui entre dans le graphe |
| --- | --- |
| `strict` | revêtement dur uniquement |
| `normal` (défaut) | revêtement dur ou meuble avéré |
| `tolerant` | accepte aussi les sentiers de revêtement inconnu |

## Tests

```bash
npm run fixtures    # rejoue le Python d'origine et enregistre ses sorties
npm test            # 72 tests
```

Les fixtures sont produites en exécutant le vrai code Python, pas une réimplémentation. Le portage JavaScript est ensuite comparé à ces sorties : verdicts de praticabilité sur plusieurs dizaines de milliers de combinaisons de tags, géométrie sphérique sur 2000 tirages, classement des boucles candidates, et distances de bout en bout sur un réseau fabriqué — où les deux versions tombent au mètre près.

Le reste de la batterie couvre la contraction du graphe, la réduction 2-cœur, l'A\* et sa pénalité, la validité du GPX produit, le chargement réel de l'interface, et la conformité du site (aucun CDN, aucun traceur, attribution présente, avertissement affiché avec le résultat).

## Vie privée

Aucun point de départ n'est écrit dans le code. Le site ne collecte rien, ne dépose aucun cookie et n'embarque aucune mesure d'audience ; il retient seulement vos réglages dans le stockage local de votre navigateur, effaçables d'un bouton. Voir les [mentions légales](https://mevennou.github.io/genere-boucle/mentions-legales.html) et la revue de conformité `AUDIT-LEGAL.md`.

## Bon usage des serveurs OpenStreetMap

Le réseau est récupéré auprès de miroirs Overpass publics, tenus par des bénévoles. Le code les interroge un par un et n'en sollicite un second que si le premier tarde, et met les réponses en cache. Merci de ne pas lancer de générations en masse : ces serveurs n'ont pas les moyens d'un service commercial.

## Crédits et licences

- Code : licence MIT, voir `LICENSE`.
- Données routières et fonds de carte : © les contributeurs [OpenStreetMap](https://www.openstreetmap.org/copyright), sous [ODbL](https://opendatacommons.org/licenses/odbl/). Les traces GPX produites portent cette attribution dans leurs métadonnées ; conservez-la en cas de republication.
- [Leaflet](https://leafletjs.com/) sous BSD-2-Clause, OpenTopoMap sous CC-BY-SA, tuiles de la Fondation OpenStreetMap et d'OpenStreetMap France.

Projet indépendant, ni affilié à la Fondation OpenStreetMap ni approuvé par elle.

## Auteur

Publié par **mevennou**.
