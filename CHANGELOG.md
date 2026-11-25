# Nouveautés de Kleos

## Version 0.7.2 — 25 novembre 2026

### Se connecter à un autre serveur sans écraser le favori

- **Un autre serveur devient un nouveau favori.** Dans le formulaire d'un favori, changer
  l'hôte, le port, la base, l'utilisateur ou le tunnel SSH ne modifie plus ce favori : le
  bouton devient « Connect as new » et crée un nouveau favori, nommé d'après la base et l'hôte
  (par exemple « postgres on 127.0.0.1 »), à moins que vous ne l'ayez renommé. Le favori
  d'origine reste tel quel.
- **Modifier le favori, quand c'est voulu.** Le lien « Update … instead » le met à jour. S'il
  est ouvert dans un onglet, Kleos demande d'abord : cet onglet reste connecté à l'ancien
  serveur jusqu'à ce que vous le fermiez.
- Le surnom, la couleur, la lecture seule, le mot de passe et le SSL modifient toujours le
  même favori, comme avant.
- **Le mot de passe suit, sur le même serveur seulement.** Même hôte, même port, même tunnel
  SSH : le nouveau favori reprend le mot de passe enregistré dans le Trousseau. Vers un autre
  hôte, il n'est jamais envoyé, pas même par « Test connection ».
- **« Duplicate ».** Un nouveau bouton crée un favori à partir de celui affiché.

### Plusieurs serveurs ouverts, mieux vérifiés

- **Fermer un onglet ne reste plus bloqué.** Si une requête lente de la grille (un filtre
  WHERE coûteux, un comptage exact sur une grosse table) tournait encore, la fermeture d'un
  onglet de serveur attendait qu'elle se termine d'elle-même, tout comme la suppression du
  favori et la sortie de Kleos. La requête est maintenant annulée et l'onglet se ferme aussitôt.
- **⌘K ne propose plus d'actions sans effet.** Quand l'onglet au premier plan est un serveur
  restauré qui attend encore sa connexion, la palette n'offre plus « Insert snippet », « Go to … »,
  « Refresh schema » ni « Search history… », qui ne faisaient rien.
- De nouveaux tests ouvrent plusieurs serveurs à la fois (deux bases, PostgreSQL 16 et 17,
  lecture seule et écriture côte à côte) et vérifient que requêtes, annulations, délais,
  exports, imports, modifications en attente, historique et moniteur restent chacun sur leur
  serveur. La visite guidée de l'application ouvre désormais un troisième serveur.

---

## Version 0.7.1 — 24 novembre 2026

### Un diagramme qui vous montre la bonne table

- **La table choisie arrive au centre, entière.** Quand vous choisissez une table dans la
  barre latérale, dans la palette ⌘K ou avec « Focus a table… », le diagramme la place au
  centre avec le bon niveau de zoom : toutes ses colonnes sont visibles, sans grossir
  exagérément une petite table.
- **Recentrer à tout moment.** Le nouveau bouton « Center on table », en haut du panneau de
  détail, ou la touche **F**, ramène la table sélectionnée au centre.
- **Tout revoir.** Le bouton « Fit to view », en bas à gauche avec les boutons de zoom,
  affiche de nouveau toutes les tables d'un coup : il ne réagissait plus depuis la 0.6.
- Le double-clic sur une table ouvre toujours ses données.

---

## Version 0.7.0 — 20 novembre 2026

### Des scripts, pas seulement des requêtes

- **« Run all ».** Un bouton (ou ⇧⌘↵) exécute toutes les instructions de l'éditeur, dans
  l'ordre. Chaque instruction a son propre résultat ; une liste permet de passer de l'une à
  l'autre. À la première erreur, Kleos s'arrête et dit laquelle a échoué et à quelle ligne
  (« Statement 15 of 20 failed · line 15 »), en soulignant l'endroit dans l'éditeur.
- Une transaction ouverte par `BEGIN` dans le script vaut pour les instructions qui suivent.

### Des paramètres

- Écrivez `$1` ou `:client` dans une requête : avant l'exécution, Kleos demande la valeur de
  chaque paramètre (« Parameters »), avec la possibilité de mettre NULL. Les valeurs sont
  transmises à Postgres à part, jamais collées dans le SQL.
- **Une requête enregistrée se souvient de ses paramètres.** Dans la palette ⌘K, tapez son
  nom puis Entrée : la fenêtre des paramètres s'ouvre déjà remplie, Entrée encore, et c'est
  parti (« Run saved query »).

### Écrire plus vite

- **Mettre en forme le SQL** : ⇧⌥F (ou le bouton « Format SQL ») range la sélection, ou tout
  l'éditeur. Un simple ⌘Z revient en arrière.
- **Des extraits réutilisables** : un nouvel onglet « Snippets », à côté de l'historique et
  des requêtes enregistrées, garde vos morceaux de SQL fréquents. Un clic les insère à
  l'endroit du curseur ; ils sont aussi dans la palette ⌘K (« Insert snippet »).

### Retrouver une ancienne requête

- **L'historique se cherche.** Tapez quelques mots dans « Search SQL and errors » : Kleos
  retrouve les exécutions dont le SQL ou l'erreur les contient, avec les mots surlignés.
  Filtrez par serveur (celui-ci ou tous) et par résultat (réussies, en erreur, annulées).
- « Search history… » dans la palette ⌘K y mène directement.

---

## Version 0.6.1 — 20 novembre 2026

### Une nouvelle icône

- Kleos change de couleurs : son icône passe à un **ciel de coucher de soleil**, du violet
  de la nuit au magenta, au corail puis à l'ambre, avec la base de données en blanc et sa
  courbe en cyan néon. On la retrouve dans le Dock, le Finder, le Launchpad, la fenêtre
  « À propos » et le DMG.
- Rien d'autre ne change dans l'application.

---

## Version 0.6.0 — 20 novembre 2026

### Modifier le schéma, sans risque

- **Créer une table.** Dans l'onglet Schéma, « New table… » : choisissez le schéma, le nom,
  puis les colonnes (nom, type avec suggestions, valeur par défaut, clé primaire).
- **Modifier une table existante.** Sélectionnez-la dans le diagramme : le panneau de
  détail permet d'ajouter une colonne, de la renommer, de changer son type, d'autoriser ou
  non les valeurs vides (NULL), de changer sa valeur par défaut ou de la supprimer. On peut
  aussi ajouter ou supprimer un index, renommer ou supprimer la table.
- **Rien ne part sans votre accord.** Les modifications s'accumulent dans un panneau
  « Pending schema changes », chacune expliquée en clair, avec **le SQL exact** qui sera
  exécuté. « Apply » (ou ⌘S) applique tout d'un coup.
- **Tout ou rien.** Si une instruction échoue (par exemple, interdire NULL sur une colonne
  qui contient des valeurs vides), rien n'est modifié : Kleos indique laquelle a échoué et
  pourquoi, et vos modifications restent prêtes à être corrigées.
- Désactivé sur les connexions en lecture seule.

### Un diagramme plus complet, à partager

- **Les tables des autres schémas** reliées par une clé étrangère apparaissent désormais
  dans le diagramme, en pointillés. Un double-clic ouvre leur schéma.
- **Exporter le diagramme** en image : « Export diagram… » propose PNG ou SVG (une image
  nette à toutes les tailles, qui s'ouvre aussi dans les outils de design), aux couleurs du
  mode clair ou sombre.

---

## Version 0.5.0 — 19 novembre 2026

### Des réglages, enfin

- **Une fenêtre « Settings ».** Menu **Kleos › Settings…** ou ⌘, (ou tapez « settings »
  dans la palette ⌘K). Trois onglets :
  - « General » : l'apparence (System, Light, Dark), avec un aperçu de chaque mode ;
  - « Data » : le nombre de lignes chargées par page dans l'onglet Données (« Rows per
    page » : 100, 200, 500 ou 1 000) et un délai maximum pour les requêtes (« Query
    timeout » : de 30 secondes à 15 minutes, ou aucun) ;
  - « Updates » : la version installée et la recherche de nouvelles versions.
- Chaque réglage s'applique tout de suite, dans toutes les fenêtres.
- Le délai maximum vaut pour les serveurs ouverts après le changement : une requête trop
  longue est arrêtée par Postgres au lieu de tourner indéfiniment.

### Être prévenu des nouvelles versions

- Au premier lancement, Kleos vous demande s'il peut vérifier une fois par jour s'il existe
  une nouvelle version (« Check for new versions? »). Tant que vous n'avez pas accepté,
  **Kleos n'envoie rien sur Internet** de lui-même ; ensuite, rien d'autre que cette
  vérification.
- Quand une nouvelle version sort, un bouton « Update available » apparaît en haut de la
  fenêtre : il affiche les nouveautés et propose de télécharger le DMG (« Download »), de
  passer cette version (« Skip this version ») ou d'y revenir plus tard (« Later »).
- Vous pouvez aussi vérifier à tout moment : **Kleos › Check for Updates…**, ou « Check
  now » dans les réglages.

### Plus simple à partager

- **Le code de Kleos est désormais public**, sous licence MIT, sur GitHub.
- **Un guide dans le DMG.** En ouvrant le fichier, la fenêtre explique comment lancer Kleos
  la première fois : Kleos ne vient pas de l'App Store, macOS demande donc une confirmation
  unique (« Open Anyway » dans Réglages Système › Confidentialité et sécurité).
- **Une empreinte pour chaque version.** Chaque version publiée indique l'empreinte
  SHA-256 du DMG, pour vérifier qu'un fichier transmis de main en main est bien l'original.

### Corrections

- Un tunnel SSH coupé est toujours signalé comme tel, même quand la base répond une
  fraction de seconde avant.
- Passer en mode sombre depuis la palette ⌘K assombrit bien toute la fenêtre.

---

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
