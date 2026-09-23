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
5. Les tronçons mis bout à bout peuvent se recroiser : le parcours repasse par un carrefour déjà vu, et le crochet entre les deux passages est une boucle en trop. Ces **lacets sont effacés** du parcours — une marche qui revient sur un point déjà atteint reste une marche valide une fois la boucle retirée, simplement plus courte, et la dichotomie sur le rayon rattrape la distance en élargissant. L'effacement est borné au quart de la distance visée : sans borne, effacer les lacets d'une boucle la réduirait à rien, puisqu'une boucle est par construction une marche qui revient sur elle-même. Le départ est le seul point qu'elle a le droit de revoir.
6. Une rue et son trottoir cartographié à part sont deux arêtes distinctes du graphe, mais une seule voie sur le terrain : elles sont regroupées en **couloirs**, pour qu'aller par l'une et revenir par l'autre compte comme un aller-retour. Quand les deux bords d'une chaussée sont cartographiés, le couloir sait lequel est à gauche du sens de la course : le bord droit est légèrement renchéri, comme le demande le code de la route hors agglomération. C'est une préférence, pas une interdiction — traverser deux fois pour changer de trottoir ne vaudrait pas la règle.
7. Le tracé retenu subit enfin un **contrôle géométrique**, sur le dessin obtenu et non sur le graphe. Il mesure deux défauts que le comptage par arête ne peut pas voir : la longueur qui longe une autre portion du parcours (aller par la rue, revenir par le trottoir), et les **petites boucles** refermées sur elles-mêmes — un crochet qui fait le tour d'un pâté de maisons et revient au même carrefour n'emprunte aucune arête deux fois. Plusieurs dizaines de candidats sont examinés, du meilleur au moins bon ; le premier tracé net l'emporte. Un repli ne peut pas coûter plus d'un cinquième de la distance demandée, sans quoi le plus court chemin direct — qui ne double rien puisqu'il ne fait aucun détour — finirait par gagner. Si aucun candidat n'est net, le défaut restant est annoncé plutôt que tu.

Le point de départ et le point d'arrivée s'accrochent au réseau **utilisable**, et non au nœud le plus proche à vol d'oiseau. La nuance compte dès qu'on cherche une adresse ou qu'on se géolocalise : le résultat tombe au milieu d'un site, d'un campus, d'un lotissement, et le nœud le plus proche appartient alors à un îlot de quelques allées sans lien avec le reste. Le moteur écarte ces îlots, remonte une impasse quand elle mène quelque part, et, en dernier recours, rapproche le point de la voie reliée au reste la plus proche — en annonçant de combien il l'a déplacé.

## Le site

Hébergé sur GitHub Pages, donc statique : il n'y a aucun serveur de calcul. Le navigateur télécharge le réseau OSM, construit le graphe et cherche la boucle sur la machine du visiteur, dans un *web worker* pour que la carte reste manipulable pendant la recherche. Conséquence heureuse : la charge reste diffuse sur les serveurs bénévoles d'OpenStreetMap, puisque chaque visiteur interroge Overpass depuis chez lui.

Le portage JavaScript est environ **neuf fois plus rapide** que la version Python, parce qu'il travaille sur des indices denses et des tableaux typés plutôt que sur des tables de hachage indexées par identifiants OSM, et qu'il réutilise ses tableaux de travail d'un appel d'A\* au suivant.

Les deux implémentations exécutent le même algorithme, et la suite de tests le vérifie au mètre près sur le réseau de référence. Sur un vrai réseau, elles peuvent retenir deux parcours différents de quelques dizaines de mètres : les primitives géométriques diffèrent d'environ 1e-11 degré entre Python et JavaScript, ce qui suffit à départager autrement deux candidats que la notation sépare à peine. Les deux tracés satisfont alors les mêmes contrôles ; ce n'est pas un désaccord sur la règle, seulement sur l'ex aequo.

### Le relief

Le parcours s'accompagne de son dénivelé positif et négatif, et d'un profil altimétrique dont l'aire est colorée par la pente : deux teintes froides pour la descente, un gris neutre pour le plat, deux teintes chaudes pour la montée. Chaque classe est nommée en légende — la couleur seule ne dit jamais l'identité — et le survol donne distance, altitude et pente au point visé. Le thème sombre a ses propres teintes plutôt qu'un éclaircissement automatique de celles du thème clair.

L'altitude ne vient pas d'un service d'altitude, qui recevrait la liste des points du parcours, donc le tracé lui-même. Elle vient de **tuiles de modèle numérique de terrain** au format Terrarium : des images ordinaires où l'altitude est encodée dans les canaux de couleur. Une tuile couvre plusieurs kilomètres carrés et ne dit rien de ce qu'on y lit ; le serveur ne reçoit que des numéros de tuiles. Le décodage et le calcul se font dans le navigateur, comme le reste.

Le dénivelé ne s'obtient pas en additionnant les différences d'altitude : un modèle de terrain se trompe de quelques mètres à la verticale à chaque point, et cette somme naïve rend deux cent soixante mètres de dénivelé sur dix kilomètres de plat. Une montée n'est donc comptée qu'à partir du moment où elle dépasse trois mètres depuis le dernier point de référence — ce que font les montres. Le prix est borné : au plus trois mètres par versant réel. La pente affichée, elle, se mesure sur cent cinquante mètres, la longueur à laquelle un coureur la ressent, et non sur un pas d'échantillonnage où le bruit la ferait changer de classe tous les vingt-cinq mètres.

La génération des parcours n'est pas touchée : le relief se lit sur le tracé une fois qu'il est trouvé. Le script Python, qui ne dessine pas de graphique, est donc inchangé.

L'interface s'adapte au téléphone : le panneau devient une feuille que l'on replie d'un geste pour dégager la carte, le bouton de génération reste ancré en bas de cette feuille quel que soit le défilement, les commandes de zoom sont placées à l'écart du panneau et dimensionnées pour le pouce, l'échelle et l'attribution remontent au-dessus de la feuille repliée, et le parcours généré replie automatiquement la feuille.

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
| `normal` (défaut) | revêtement dur, ou chemin naturel portant une preuve d'entretien |
| `tolerant` | accepte aussi les sentiers sans revêtement ni documentation |

Le niveau `normal` se méfie particulièrement du sous-bois. Un sentier en terre battue, sans nom, sans balisage, sans éclairage et sans état renseigné n'y entre pas : c'est le profil du chemin forestier oublié, qu'un arbre tombé ou un roncier suffit à rendre impraticable sans que la carte en sache rien. Il faut au moins un signe d'entretien — un nom, une appartenance à un itinéraire balisé, un éclairage public, une visibilité ou une qualité de surface renseignées. Sont écartés à tous les niveaux les chemins dont OpenStreetMap signale un encombrement (`obstacle=vegetation`, `log`, `fallen_tree`, `rockfall`…), et au niveau `normal` les chemins naturels notés `smoothness=very_bad`, c'est-à-dire ornières et racines.

Cela reste un filtrage sur les **données**, pas sur le terrain : une carte peut être incomplète ou datée. L'itinéraire est à vérifier avant de le courir.

## Tests

Les réseaux fabriqués des tests sont des damiers : trop réguliers pour produire les défauts qui apparaissent en ville. Un balayage sur ces damiers ne trouvait aucune petite boucle alors que le site en produisait sur le terrain — c'est le trou qui a laissé passer le défaut. `tests/fixtures/brest.json` est donc une extraction réelle figée dans le dépôt, environ 2,6 km autour du Technopôle de Brest, avec ses sentiers côtiers et ses trottoirs cartographiés à part. Elle ne contient que les tags lus par `evalue_voie` et des coordonnées arrondies au millionième : elle sert à mesurer la forme du tracé, pas à rendre une carte.

```bash
npm run fixtures    # rejoue le Python d'origine et enregistre ses sorties
npm test            # 87 tests
```

Les fixtures sont produites en exécutant le vrai code Python, pas une réimplémentation. Le portage JavaScript est ensuite comparé à ces sorties : verdicts de praticabilité sur plusieurs dizaines de milliers de combinaisons de tags, géométrie sphérique sur 2000 tirages, classement des boucles candidates, et distances de bout en bout sur un réseau fabriqué — où les deux versions tombent au mètre près.

Le reste de la batterie couvre la contraction du graphe, la réduction 2-cœur, l'A\* et sa pénalité, la validité du GPX produit, le chargement réel de l'interface, et la conformité du site (aucun CDN, aucun traceur, attribution présente, avertissement affiché avec le résultat).

## Statistiques d'usage

Le site compte trois événements : ouverture de la page, génération réussie,
génération en échec. Il transmet le nom de l'événement, une tranche de distance
parmi six et le niveau d'exigence — jamais le point de départ, le tracé,
l'adresse recherchée ni le moindre identifiant. Le compteur n'enregistre que
des agrégats journaliers, sans adresse IP ni ligne par visiteur, ce qui permet
de se passer de bandeau de consentement. Global Privacy Control, Do Not Track
et le lien « Ne pas être compté » sont respectés.

La mesure est **désactivée par défaut** : sans adresse renseignée dans la balise
`point-de-mesure` de `docs/index.html`, le site n'émet aucun appel. Pour
déployer son propre compteur, voir `compteur/README.md`. La version Python ne
comporte aucun comptage.

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
