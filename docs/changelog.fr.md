## v0.1.99 — 2026-08-09

### Terminal

- **Shift+Entrée insère un saut de ligne au lieu d'envoyer.** Les terminaux ne disposent d'aucun encodage pour Entrée avec une touche de modification : les CLI d'agents comme Claude Code et Codex ne recevaient qu'un retour chariot ordinaire et envoyaient l'invite alors qu'on était encore en train de l'écrire. VelaTerm émet désormais ESC+CR, la séquence même que ces outils attendent d'une correspondance de touches iTerm2, ce qui rend les saisies multilignes utilisables — y compris sur macOS, où le gestionnaire de touches personnalisé n'était tout simplement pas installé. La composition dans une méthode de saisie reste inchangée : Entrée valide toujours le candidat.

### Projets et organisation

- **Actualiser l'état d'une seule session.** Dans un volet filtré par état, les sessions disposent d'une action « Actualiser l'état » qui réévalue uniquement cette session selon les conditions propres au volet, l'ajoutant ou la retirant tandis que toutes les autres restent en place. L'action appartient au volet depuis lequel le menu a été ouvert, si bien que les divisions imbriquées n'empruntent jamais le filtre d'un autre volet. Le résultat est conservé par volet et restauré après un redémarrage.
- **Retirer un marqueur ne demande qu'un clic.** Choisir l'emoji déjà appliqué le supprime, ce qui rend inutiles l'entrée dédiée au retrait et son séparateur. La pastille emoji du bouton de filtre disparaît elle aussi : la mise en évidence indique déjà qu'un filtre par marqueur est actif, et le menu précise lequel.

### Corrections

- **L'intégration au bureau de l'AppImage Linux s'installe sur n'importe quelle machine.** L'icône fournie était un lien symbolique vers un chemin absolu de la machine de compilation ; des outils comme Gear Lever et AppImageLauncher ne parvenaient donc pas à l'extraire, alors même que l'application fonctionnait normalement. Le lien est désormais relatif. L'exigence glibc annoncée a également été corrigée à 2.35 après mesure des bibliothèques fournies et non du seul exécutable, ce qui fait d'Ubuntu 22.04 la plus ancienne distribution prise en charge par l'application de bureau.

## v0.1.98 — 2026-08-02

### Agents IA

- **Grok Build devient un agent de premier plan dans VelaTerm.** Installez, lancez et reprenez Grok 4.5 avec des identifiants de session stables, les lifecycle hooks officiels, des états de travail et d’autorisation précis, des transcriptions fusionnées, le détail de l’utilisation et une icône officielle adaptée au thème, de façon cohérente sur ordinateur, navigateur et mobile.

### Projets et organisation

- **Divisez la barre latérale des projets en vues de travail indépendantes.** Chaque volet de l’arborescence peut à nouveau être divisé vers le bas et retrouve après redémarrage sa recherche, ses filtres d’état et d’emoji, son état de repli et son ratio de redimensionnement. Tous les volets restent des projections de la même arborescence gérée par le backend : les modifications se synchronisent sans dupliquer les données métier.
- **Marquez et filtrez les nœuds sans perdre leur contexte.** Les projets, groupes et sessions peuvent porter des marqueurs emoji. Un conteneur marqué conserve tout son sous-arbre, l’appartenance aux états reste stable pendant le travail, l’ajout dynamique et l’actualisation manuelle sont disponibles, et les conditions d’état et d’emoji sont réunies par union.
- **Créez un projet vide sur place.** Choisissez le répertoire parent, validez le nom, puis créez et importez le dossier dans un même parcours. En cas d’échec partiel, seule l’importation est relancée, sans créer de répertoire en double.

### Interface

- **Partagez VelaTerm là où se trouve votre communauté.** La boîte de dialogue prend désormais en charge WeChat Moments, Weibo, Xiaohongshu, X, Reddit, Hacker News, LinkedIn, Facebook, Telegram et WhatsApp, avec un parcours par code QR pour WeChat et une invitation au partage dans la fenêtre de mise à jour.
- **Des interactions plus soignées jusque dans les détails.** Les onglets de terminal temporaires peuvent être renommés avant de devenir des sessions enregistrées. Les champs ordinaires désactivent la mise en majuscule automatique des claviers mobiles sans modifier la saisie dans le terminal.

## v0.1.97 — 2026-07-25

### Agents IA

- **Les sessions ne restent plus bloquées sur « en cours ».** Codex signalait l’activité des outils et la fin d’un tour depuis des processus éphémères distincts, dont les rappels pouvaient arriver dans le désordre et laisser un tour terminé affiché comme encore en cours. Les rapports intermédiaires arrivant après la fin de leur propre tour sont désormais ignorés, et un nouveau hook de fin de session couvre les sessions qui se terminent sans événement de complétion.
- **Les tours interrompus se stabilisent en quelques secondes.** Appuyer sur Esc, ou une erreur de flux, met fin à un tour Claude ou Codex sans le moindre rappel de complétion. Six secondes de silence du terminal corrigent maintenant discrètement une telle session en attente, sans déclencher de notification « a répondu ».

### Interface

- **Raccourcis de division fiables sous macOS.** Diviser à droite (Cmd+D) et diviser vers le bas (Cmd+Shift+D) sont désormais enregistrés comme commandes du menu Terminal natif, si bien que macOS n’intercepte plus la combinaison avant VelaTerm.
- **Un seul enregistrement par frappe.** Cmd+S était traité à la fois par le raccourci global et par l’éditeur actif, ce qui pouvait écrire deux fois le même fichier en une seule frappe.

## v0.1.96 — 2026-07-23

### Agents IA

- **L’état de Codex repose sur les lifecycle hooks, pas sur des suppositions tirées du terminal.** Les sessions Codex récentes utilisent désormais uniquement les lifecycle hooks officiels comme source d’activité. Une poignée de main `SessionStart` vérifie la liaison, l’absence de rappel affiche « État indisponible », et le texte ou l’activité du terminal ne peut plus écraser les états de travail, de confirmation ou de fin.
- **Une utilisation Codex plus fraîche après chaque tour.** Le panneau Info affiche immédiatement le snapshot rollout local, le rapproche des limites en direct, actualise à nouveau après l’écriture du snapshot token final par Codex et ignore les réponses tardives d’une ancienne session.

### Interface

- **Ciblage fiable dans l’arborescence des projets sous macOS.** Les lignes virtuelles ne dépendent plus des transform du compositeur, ce qui empêche d’anciennes coordonnées de hit-test WKWebView d’envoyer le survol, le clic ou le glisser vers une autre ligne après un défilement ou une mise à jour de l’arborescence.

## v0.1.95 — 2026-07-21

### Agents IA

- **Kimi Code et Zoo Code rejoignent l’arborescence des sessions.** VelaTerm peut désormais lancer, reprendre, installer et configurer ces deux agents. Kimi utilise ses lifecycle hooks officiels pour signaler précisément les états de travail, d’autorisation et d’attente ; Zoo Code conserve un identifiant de tâche stable et utilise la détection du terminal en l’absence de hooks externes.
- **Actualisation en direct de l’utilisation Codex.** Le panneau Info interroge le Codex app server pour obtenir les limites actuelles, avec repli compatible sur l’instantané rollout local.

### Projets et terminaux

- **Ouvrez un projet avec `vela <path>`.** Les versions empaquetées peuvent installer une commande shell à la manière de VS Code. Un second appel transmet le projet à la fenêtre VelaTerm existante au lieu d’ouvrir une instance en double.
- **Clonage Git visible et annulable.** Clone Project affiche les étapes Git, le pourcentage et le temps écoulé, avertit en cas de blocage et peut arrêter tout l’arbre de processus Git sans laisser de cible incomplète. Les identifiants et query tokens sont masqués dans les erreurs et journaux d’audit.
- **Terminaux WSL sous Windows.** Toutes les distributions WSL installées sont proposées avec PowerShell, cmd et Git Bash pour les terminaux ordinaires. Les agents restent dans le shell hôte Windows afin de préserver la fiabilité des hooks et des chemins exécutables.

### Interface et fiabilité

- **Contrôle plus clair des sessions en arrière-plan.** Les menus affichent l’état en direct de chaque session et la boîte de dépassement de limite peut fermer plusieurs onglets sélectionnés à la fois.
- **Cycle de vie plus sûr et notes multilingues.** Une confirmation précède l’arrêt des sessions actives ; l’identité lifecycle exacte de Codex prime sur les scans rollout ambigus ; les notes de mise à jour couvrent toutes les langues intégrées.

## v0.1.94 — 2026-07-12

### Localisation

- **Interface en vietnamien.** Tiếng Việt est désormais disponible dans le sélecteur de langue et est sélectionné automatiquement lorsque le système utilise une locale vietnamienne.

### Navigateur

- **Démarrage plus rapide du navigateur intégré.** Chaque onglet comporte maintenant des raccourcis en un clic vers ChatGPT, Claude, Gemini et Google. Les menus contextuels des projets et des groupes permettent aussi de créer directement une page de navigateur permanente à l'endroit correspondant dans l'arborescence des sessions.

### Images et documents

- **Collage fiable des chemins d'image sous macOS.** Lorsque WebKit n'expose pas une image copiée sous forme de fichier, VelaTerm la lit désormais depuis le presse-papiers natif et l'envoie tout de même sous forme de chemin de fichier, sans basculer silencieusement vers l'espace réservé aux images propre à l'agent. Les fenêtres distantes affichent toujours le réglage de collage d'image, expliquent pourquoi le mode chemin de fichier est requis et désactivent l'option native indisponible.
- **Collage d'images dans les documents source.** L'éditeur source accepte désormais les images du presse-papiers. Les documents Markdown enregistrés les stockent à côté du document dans `assets/` et insèrent une syntaxe d'image Markdown portable ; les brouillons non enregistrés intègrent les données de l'image afin qu'elles ne soient pas perdues lors du nettoyage des fichiers temporaires.

### Interface

- **Des menus contextuels visibles et ciblant le bon élément.** Les menus ouverts près du bord droit sont correctement mesurés et repositionnés. Un clic droit sur un nœud de l'arborescence ne met désormais en évidence que la cible du menu sans modifier la sélection existante, et les menus de groupe proposent un terminal limité à ce groupe.
- **Édition et libellés d'état plus nets.** Le texte source n'affiche plus de ligatures en forme de flèche pour des séquences telles que les commentaires HTML, les pourcentages d'utilisation sont explicitement libellés comme utilisés, et le menu contextuel natif sans rapport du WebView hôte n'apparaît plus derrière les menus de VelaTerm.

### Corrections

- **Codex reste dans l'historique normal du terminal.** Les sessions Codex lancées par VelaTerm utilisent désormais le mode terminal en ligne. Appuyer sur Esc pour interrompre ou revenir en arrière ne change donc plus les tampons d'écran du terminal et ne fait plus sauter la vue de défilement en haut. Votre propre configuration Codex reste intacte.
