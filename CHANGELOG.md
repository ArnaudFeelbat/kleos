# Nouveautés de Kleos

## Version 0.4.0 — 19 novembre 2026

### Se connecter partout

- **Tunnel SSH.** Dans une connexion, activez « Connect through SSH » pour passer par un
  serveur intermédiaire (bastion). Deux façons de s'authentifier :
  - « SSH agent » : les clés déjà chargées sur votre Mac (`ssh-add`) ;
  - « Key file » : un fichier de clé privée, choisi avec « Choose… ». Si la clé est
    protégée, sa phrase de passe peut être gardée dans le trousseau macOS (« Remember in
    Keychain »).
- **Sécurité du serveur SSH.** À la première connexion, Kleos affiche l'empreinte du
  serveur (« Trust this server? ») : vérifiez-la, puis « Trust and connect ». Si cette
  empreinte change un jour, Kleos refuse de se connecter et vous prévient. Si vous savez
  pourquoi (serveur réinstallé), « Replace the trusted key… » permet de faire confiance à la
  nouvelle, après une seconde confirmation.
- **Certificat d'autorité (CA).** En SSL `require` ou `verify-full`, vous pouvez indiquer
  votre propre certificat (« CA certificate »), par exemple celui de votre hébergeur.
  « Test connection » indique désormais clairement si la connexion est chiffrée et si elle
  passe par SSH.

### Exporter et importer

- **Export en CSV, JSON ou Excel.** Le bouton « Export… » de l'onglet Données exporte
  toute la table, avec vos filtres et votre tri, et pas seulement la page affichée. Le même
  bouton, à côté de « Copy as CSV », exporte le résultat complet d'une requête (elle est
  relancée pour l'occasion). Pour le CSV, « CSV options » permet de choisir le séparateur
  (virgule, point-virgule, tabulation) et la ligne d'en-tête.
- **Rapide, même sur de très grosses tables.** L'export s'écrit directement sur le disque,
  ligne après ligne : un million de lignes ne fait pas gonfler la mémoire. Une notification
  suit l'avancement ; vous pouvez l'annuler ou, une fois fini, cliquer sur « Show in Finder ».
- **Import CSV.** « Import CSV… » ouvre un aperçu du fichier :
  - le séparateur est détecté tout seul (modifiable) ;
  - « First row is a header » indique si la première ligne contient les noms de colonnes ;
  - chaque colonne du fichier est associée à une colonne de la table (automatiquement quand
    les noms correspondent) ;
  - « Treat as NULL » précise quelles valeurs signifient « vide » ;
  - un aperçu montre les premières lignes telles qu'elles arriveront dans la table.
- **Tout ou rien.** L'import se fait en une seule fois : si une ligne pose problème, rien
  n'est importé, et Kleos vous dit laquelle (« line 1204 ») et quelle colonne. L'import est
  désactivé sur les connexions en lecture seule.

### Reprendre là où vous en étiez

- Quand vous relancez Kleos, vos serveurs rouvrent dans leurs onglets, avec leurs requêtes
  en cours et l'onglet sur lequel vous étiez.
- Si un mot de passe n'est pas enregistré dans le trousseau, l'onglet l'indique
  calmement : un clic sur « Connect » suffit.

### Petites améliorations

- **En-têtes de colonnes au clavier.** Depuis la première ligne, la flèche ↑ mène aux
  en-têtes ; ← et → passent de l'un à l'autre, Entrée trie, ⌥← et ⌥→ déplacent la colonne.
- **Plus de colonnes qui sautent.** À l'ouverture d'une table, la disposition mémorisée
  s'applique tout de suite ; si elle arrive en retard, elle ne bouscule plus ce que vous
  avez déjà modifié.
- **Lecture seule : un point d'attention signalé.** Si l'extension `dblink` est installée
  sur la base, un badge « dblink » le signale à côté de « Read-only » : `dblink` peut écrire
  sur d'autres serveurs, ce que la lecture seule ne peut pas empêcher.

---

## Version 0.3.0 — 18 novembre 2026

### Tout trouver avec ⌘K

- **Une palette de commandes.** Appuyez sur ⌘K (ou cliquez sur « Search » en haut à
  droite) et tapez quelques lettres pour aller directement où vous voulez :
  - un serveur déjà ouvert ;
  - une connexion enregistrée, pour l'ouvrir (le mot de passe est demandé si besoin) ;
  - n'importe quelle table ou vue, sur tous les serveurs ouverts à la fois ;
  - une requête enregistrée, avec son graphique ;
  - une action : passer à Schéma, Données, Requête ou Monitoring, actualiser le schéma,
    fermer l'onglet…
- La recherche se fait par mots : taper « orders prod » trouve la table `orders` du serveur
  « prod ».

### Mode clair ou sombre, au choix

- Kleos peut désormais suivre le réglage de votre Mac, ou rester toujours en mode clair ou
  toujours en mode sombre.
- Trois façons de changer : le menu **View › Appearance**, le raccourci ⌘⇧L (bascule
  clair / sombre), ou la palette ⌘K (tapez « appearance », « light » ou « dark »).
- Votre choix est mémorisé d'un lancement à l'autre.

### Données et requêtes

- **Filtres modifiables.** Cliquez sur un filtre pour le corriger (colonne, condition,
  valeur) au lieu de devoir le supprimer et le recréer.
- **Colonnes à votre goût.** Glissez un en-tête de colonne pour la déplacer et ajustez sa
  largeur : Kleos s'en souvient pour chaque table. « Reset columns » remet tout
  comme au départ. Au clavier : ⌥← et ⌥→ déplacent la colonne sélectionnée.
- **Plus de requête perdue.** Cliquer sur une requête de l'historique ne remplace plus votre
  texte sans prévenir : Kleos propose de l'ouvrir dans un nouvel onglet, de remplacer, ou
  d'annuler.
- **Tables sans clé primaire.** Vous pouvez désormais y ajouter des lignes. Les lignes
  existantes restent protégées : sans clé primaire, impossible de savoir avec certitude
  laquelle modifier ou supprimer.

### Lecture seule vraiment étanche

- Sur une connexion en lecture seule, plus aucun moyen d'écrire, même en tapant une commande
  qui tente de réactiver l'écriture dans l'éditeur de requêtes.
- **Bon à savoir :** en lecture seule, chaque requête s'exécute de façon isolée. Un réglage
  comme `SET search_path` ne s'applique donc qu'à la requête en cours, et les commandes de
  maintenance (`VACUUM`, `CREATE INDEX CONCURRENTLY`…) ne sont pas disponibles. Utilisez une
  connexion en écriture pour ces opérations.

---

## Version 0.2.0 — 18 novembre 2026

### Plusieurs serveurs dans une seule fenêtre

- **Un onglet par serveur.** Kleos s'ouvre désormais dans une seule fenêtre. Chaque serveur
  auquel vous vous connectez apparaît dans son propre onglet, en haut de la fenêtre, avec sa
  pastille de couleur et son nom.
- **Pas de doublon.** Si un serveur est déjà ouvert, vous connecter à nouveau vous ramène
  simplement à son onglet.
- **Rien ne se perd en changeant d'onglet.** Chaque serveur garde ses requêtes, ses
  modifications en attente et son diagramme pendant que vous travaillez ailleurs.
- **Fermer proprement.** Fermer un onglet ferme la connexion à ce serveur ; fermer la fenêtre
  ferme toutes les connexions.
- **Lecture seule bien visible.** Les connexions en lecture seule affichent un cadenas dans
  leur onglet.
- **Nouveaux raccourcis :**
  - ⌘T : revenir à la liste des connexions pour en ouvrir une autre
  - ⌘W : fermer l'onglet en cours
  - ⌘1 à ⌘9 : aller directement à un onglet (⌘9 = le dernier)
  - ⌘⇧] et ⌘⇧[ : onglet suivant / précédent

### Un nouveau design, plus soigné

- **Intégré à macOS.** La barre latérale et la barre d'onglets sont translucides et laissent
  transparaître votre bureau, comme dans les apps d'Apple.
- **Une couleur d'accent.** Le bleu de l'icône Kleos marque désormais la sélection, les
  boutons principaux et l'onglet actif.
- **Plus de profondeur.** Cartes en relief, ombres plus douces, transitions discrètes et
  barres de défilement fines.
- **Mode sombre retravaillé**, écran par écran.
- **Tous les écrans revus :** connexions, diagramme du schéma, données, éditeur de requêtes,
  graphiques, plan d'exécution et monitoring.
- **Monitoring :** une mini-courbe des transactions par seconde apparaît directement dans sa
  tuile.
- **États plus clairs :** messages quand une liste est vide, chargements animés et
  notifications harmonisées.

### Améliorations

- À l'ouverture d'une base, Kleos affiche directement le schéma qui contient vos tables,
  au lieu d'un schéma « public » vide.
- Boutons et champs plus compacts, au format habituel des applications Mac.

### Corrections

- Dans l'éditeur de requêtes, le soulignement de l'erreur disparaissait après un changement
  d'onglet. Il reste maintenant affiché tant que la requête n'est pas relancée.

### Bon à savoir

- La couleur choisie pour une connexion teinte désormais son onglet et sa barre d'outils,
  plutôt que toute la fenêtre.

---

## Version 0.1.0 — 18 novembre 2026

Première version de Kleos :

- connexions enregistrées, avec les mots de passe gardés dans le trousseau macOS ;
- diagramme du schéma, avec la disposition des tables mémorisée ;
- consultation des données avec tri, filtres et modifications vérifiées avant d'être
  appliquées ;
- éditeur SQL avec autocomplétion, graphiques et plan d'exécution ;
- monitoring en direct : sessions, verrous, activité et requêtes lentes.
