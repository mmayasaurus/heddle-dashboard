## v0.1.100 — 2026-08-10

### KI-Agenten

- **Kiro CLI ist jetzt ein vollwertiger Sitzungstyp.** Kiro-Sitzungen erhalten einen eigenen Knoten im Baum, einen verlässlichen Arbeits- und Wartezustand aus Kiros eigenen lifecycle hooks, Benachrichtigungen am Ende eines Durchlaufs, das automatische Fortsetzen derselben Unterhaltung beim erneuten Öffnen des Knotens, Startargumente samt Schalter zum Überspringen von Bestätigungen sowie den Start über vspawn – alles, was die übrigen Agenten bereits hatten. VelaTerm kopiert Ihren Standard-Kiro-Agenten in einen eigenen `vlx-term`-Agenten, ergänzt die Kopie um rein beobachtende lifecycle hooks und startet diese – Ihre eigene Agentendatei wird nie verändert, und Ihr prompt, Ihre Werkzeuge und Ihre MCP-Server werden unverändert übernommen. Kiro besitzt keinen hook für Berechtigungsanfragen, deshalb bleibt der Statuspunkt auf „arbeitet“ stehen, während Kiro auf Ihre Bestätigung wartet.

### Fehlerbehebungen

- **Aus dem Terminal gestartete Programme erben nicht mehr die Umgebung des AppImage (Linux).** Der AppImage-Starter richtet `PYTHONHOME`, `PYTHONPATH`, `PERLLIB`, `QT_PLUGIN_PATH` und die GStreamer-Plugin-Pfade auf das temporäre Einhängeverzeichnis des Pakets aus und stellt dessen Verzeichnisse in `PATH` und `LD_LIBRARY_PATH` allem anderen voran. Ein Terminal gibt seine gesamte Umgebung an die gestartete Shell weiter, deshalb suchte das System-`python3` seine Standardbibliothek im Paket und startete überhaupt nicht mehr, und andere dynamisch gelinkte Programme luden die Bibliothekskopie aus dem Paket statt der des Systems. VelaTerm entfernt diese Paketpfade jetzt, bevor eine Shell oder ein externes Werkzeug gestartet wird, und lässt selbst gesetzte Werte unangetastet. `APPDIR` und `APPIMAGE` bleiben sichtbar, damit Programme, die prüfen, ob sie aus einem AppImage laufen, weiterhin ihre Antwort erhalten. Betroffen waren nur AppImage-Builds; das deb-Paket, macOS und Windows verhalten sich wie bisher.

## v0.1.99 — 2026-08-09

### Terminal

- **Shift+Enter fügt einen Zeilenumbruch ein, statt abzuschicken.** Terminals kennen keine Kodierung für Enter mit Zusatztaste, deshalb erhielten Agenten-CLIs wie Claude Code und Codex nur einen einfachen Wagenrücklauf und schickten die Eingabe ab, während man noch schrieb. VelaTerm sendet nun ESC+CR, also genau die Sequenz, die diese Werkzeuge von einer iTerm2-Tastenbelegung erwarten. Damit funktionieren mehrzeilige Eingaben – auch unter macOS, wo die eigene Tastenbehandlung bisher überhaupt nicht installiert war. Während der Eingabemethoden-Komposition bleibt alles unverändert, Enter bestätigt weiterhin den Kandidaten.

### Projekte und Organisation

- **Den Status einer einzelnen Sitzung aktualisieren.** Sitzungen in einem statusgefilterten Bereich erhalten die Aktion „Status aktualisieren“, die ausschließlich diese eine Sitzung anhand der Bedingungen des jeweiligen Bereichs neu bewertet und sie aufnimmt oder entfernt, während alle übrigen Sitzungen an ihrem Platz bleiben. Die Aktion gehört zu dem Bereich, aus dem das Menü geöffnet wurde, sodass verschachtelte Teilungen nie den Filter eines anderen Bereichs verwenden. Das Ergebnis wird pro Bereich gespeichert und nach einem Neustart wiederhergestellt.
- **Eine Markierung zu entfernen kostet einen Klick.** Wer das bereits gesetzte Emoji erneut auswählt, entfernt es damit; der eigene Eintrag zum Entfernen und seine Trennlinie entfallen. Auch das Emoji-Abzeichen an der Filterschaltfläche ist verschwunden: Die Hervorhebung zeigt bereits, dass ein Markierungsfilter aktiv ist, und welches Emoji es ist, steht im Menü.

### Fehlerbehebungen

- **Die Desktop-Integration des Linux-AppImage lässt sich auf jedem Rechner installieren.** Das mitgelieferte Symbol war ein symbolischer Link auf einen absoluten Pfad des Build-Rechners, weshalb Werkzeuge wie Gear Lever und AppImageLauncher es nicht extrahieren konnten, obwohl die Anwendung selbst normal lief. Der Link ist jetzt relativ. Außerdem wurde die angegebene glibc-Anforderung auf 2.35 korrigiert, nachdem nicht nur die ausführbare Datei, sondern auch die mitgelieferten Bibliotheken gemessen wurden. Damit ist Ubuntu 22.04 die älteste unterstützte Distribution für die Desktop-Anwendung.

## v0.1.98 — 2026-08-02

### KI-Agenten

- **Grok Build wird zu einem vollwertigen Agenten in VelaTerm.** Grok 4.5 lässt sich installieren, starten und fortsetzen – mit stabilen Sitzungs-IDs, offiziellen lifecycle hooks, präzisen Arbeits- und Berechtigungszuständen, zusammengeführten Transkripten, Nutzungsdetails und einem offiziellen, an das Theme angepassten Symbol in Desktop-, Browser- und Mobilansichten.

### Projekte und Organisation

- **Teilen Sie die Projekt-Seitenleiste in unabhängige Arbeitsansichten.** Jeder Baumbereich kann erneut nach unten geteilt werden und stellt nach einem Neustart seine eigene Suche, Status- und Emoji-Filter, den eingeklappten Zustand sowie das Größenverhältnis wieder her. Alle Bereiche bleiben Projektionen desselben, vom Backend verwalteten Projektbaums, sodass Änderungen ohne doppelte Geschäftsdaten synchron bleiben.
- **Markieren und filtern Sie Knoten, ohne den Kontext zu verlieren.** Projekte, Gruppen und Sitzungen können Emoji-Markierungen tragen. Ein markierter Container behält seinen vollständigen Unterbaum, die Statuszugehörigkeit bleibt während der Arbeit stabil, dynamisches Hinzufügen und manuelles Aktualisieren stehen beide bereit, und Status- sowie Emoji-Bedingungen werden als Vereinigungsmenge kombiniert.
- **Erstellen Sie direkt ein leeres Projekt.** Wählen Sie ein übergeordnetes Verzeichnis, prüfen Sie den Namen und erstellen und importieren Sie den Ordner in einem Ablauf. Bei einem Teilfehler wird nur der Import wiederholt, ohne doppelte Verzeichnisse anzulegen.

### Oberfläche

- **Teilen Sie VelaTerm dort, wo Ihre Community ist.** Der Teilen-Dialog unterstützt jetzt WeChat Moments, Weibo, Xiaohongshu, X, Reddit, Hacker News, LinkedIn, Facebook, Telegram und WhatsApp – einschließlich QR-Code-Ablauf für WeChat und einem Teilen-Hinweis im Aktualisierungsdialog.
- **Auch kleine Interaktionen wirken durchdachter.** Temporäre Terminal-Tabs lassen sich umbenennen, bevor sie zu gespeicherten Sitzungen werden. Normale Eingabefelder deaktivieren die automatische Großschreibung mobiler Tastaturen, ohne die Terminaleingabe zu verändern.

## v0.1.97 — 2026-07-25

### KI-Agenten

- **Sitzungen bleiben nicht mehr auf „arbeitet“ stehen.** Codex meldete Werkzeugaktivität und Durchlaufende über getrennte, kurzlebige Prozesse, deren Callbacks in vertauschter Reihenfolge eintreffen konnten, sodass ein bereits beendeter Durchlauf weiterhin als arbeitend angezeigt wurde. Zwischenmeldungen, die nach dem Ende ihres eigenen Durchlaufs eintreffen, werden nun verworfen, und ein zusätzlicher Sitzungsende-hook deckt Sitzungen ab, die ohne Abschlussereignis enden.
- **Abgebrochene Durchläufe klären sich in Sekunden.** Esc oder ein Stream-Fehler beendet einen Claude- oder Codex-Durchlauf ganz ohne Abschluss-Callback. Sechs Sekunden Stille im Terminal korrigieren eine solche Sitzung jetzt still auf wartend, ohne eine „hat geantwortet“-Benachrichtigung auszulösen.

### Oberfläche

- **Zuverlässige Teilen-Kurzbefehle unter macOS.** Rechts teilen (Cmd+D) und nach unten teilen (Cmd+Shift+D) sind nun auch als native Terminal-Menübefehle registriert, sodass macOS die Tastenkombination nicht mehr vor VelaTerm abfängt.
- **Pro Tastendruck genau ein Speichervorgang.** Cmd+S wurde sowohl vom globalen Kurzbefehl als auch vom fokussierten Editor verarbeitet und konnte dieselbe Datei bei einem einzigen Tastendruck zweimal schreiben.

## v0.1.96 — 2026-07-23

### KI-Agenten

- **Codex-Status aus lifecycle hooks statt Terminalvermutungen.** Aktuelle Codex-Sitzungen verwenden ausschließlich die offiziellen lifecycle hooks als Aktivitätsquelle. Ein `SessionStart`-Handshake prüft die Verbindung, fehlende Callbacks werden als „Status nicht verfügbar“ angezeigt und Terminaltext oder Ausgabeaktivität kann Arbeits-, Bestätigungs- oder Abschlusszustände nicht mehr überschreiben.
- **Aktuellere Codex-Nutzung nach jedem Durchlauf.** Der Info-Bereich zeigt sofort den lokalen rollout-Snapshot, gleicht ihn mit den Live-Limits ab, aktualisiert nach dem letzten von Codex geschriebenen token-Snapshot erneut und verwirft verspätete Antworten einer älteren Sitzung.

### Oberfläche

- **Zuverlässige Treffer im Projektbaum unter macOS.** Virtuelle Zeilen benötigen keine Compositor-transform mehr. Dadurch können veraltete WKWebView-Hit-Test-Koordinaten Hover-, Klick- oder Ziehaktionen nach dem Scrollen oder einer Baumaktualisierung nicht mehr an eine andere Zeile senden.

## v0.1.95 — 2026-07-21

### KI-Agenten

- **Kimi Code und Zoo Code sind jetzt im Sitzungsbaum verfügbar.** VelaTerm kann beide Agenten starten, fortsetzen, installieren und konfigurieren. Kimi meldet Arbeits-, Berechtigungs- und Wartezustände über offizielle lifecycle hooks; Zoo Code behält eine stabile Task-ID und nutzt bei fehlenden externen hooks die Terminalerkennung.
- **Codex-Nutzung live aktualisieren.** Der Info-Bereich fragt aktuelle Limits beim Codex app server ab und fällt kompatibel auf den lokalen rollout-Snapshot zurück.

### Projekte und Terminals

- **Projekte mit `vela <path>` öffnen.** Paketierte Builds können einen Shell-Befehl nach VS-Code-Vorbild installieren. Ein zweiter Aufruf übergibt das Projekt an das vorhandene VelaTerm-Fenster, statt eine doppelte Instanz zu öffnen.
- **Sichtbares, abbrechbares Git-Klonen.** Clone Project zeigt Git-Phase, Prozent und Laufzeit, warnt bei Stillstand und beendet beim Abbruch den gesamten Git-Prozessbaum ohne halbfertiges Ziel. Zugangsdaten und query tokens werden in Fehlern und Audit-Logs geschwärzt.
- **WSL-Terminals unter Windows.** Alle installierten WSL-Distributionen stehen neben PowerShell, cmd und Git Bash für normale Terminals bereit. Agent-Sitzungen bleiben im Windows-Host-Shell, damit hooks und Programmpfade zuverlässig funktionieren.

### Oberfläche und Zuverlässigkeit

- **Klarere Kontrolle über Hintergrundsitzungen.** Menüs zeigen den Live-Status jeder Sitzung; im Limitdialog lassen sich mehrere ausgewählte Tabs gleichzeitig beenden.
- **Sichererer App-Lebenszyklus und mehrsprachige Hinweise.** Vor dem Beenden aktiver Sitzungen wird bestätigt, die genaue Codex-lifecycle-Identität hat Vorrang vor mehrdeutigen rollout-Scans und Update-Hinweise unterstützen alle integrierten Sprachen.

## v0.1.94 — 2026-07-12

### Lokalisierung

- **Vietnamesische Benutzeroberfläche.** Tiếng Việt ist jetzt in der Sprachauswahl verfügbar und wird bei vietnamesischen Systemgebietsschemas automatisch ausgewählt.

### Browser

- **Schnellerer Start des integrierten Browsers.** Jeder Browser-Tab bietet jetzt Ein-Klick-Verknüpfungen für ChatGPT, Claude, Gemini und Google. Über die Kontextmenüs von Projekten und Gruppen lässt sich außerdem direkt an der entsprechenden Stelle im Sitzungsbaum eine dauerhafte Browserseite erstellen.

### Bilder und Dokumente

- **Zuverlässiges Einfügen von Bildpfaden unter macOS.** Wenn WebKit ein kopiertes Bild nicht als Datei bereitstellt, liest VelaTerm es jetzt aus der nativen Zwischenablage und lädt es weiterhin als Dateipfad hoch, statt unbemerkt auf den nativen Bildplatzhalter eines Agenten zurückzufallen. Remote-Fenster zeigen die Einstellung zum Einfügen von Bildern immer an, erklären, warum der Dateipfadmodus erforderlich ist, und deaktivieren die nicht verfügbare native Option.
- **Bilder in Quelldokumente einfügen.** Der Quelltexteditor akzeptiert jetzt Bilder aus der Zwischenablage. Gespeicherte Markdown-Dokumente legen sie neben dem Dokument unter `assets/` ab und fügen portable Markdown-Bildsyntax ein. Nicht gespeicherte Entwürfe betten die Bilddaten ein, damit sie beim Bereinigen temporärer Dateien nicht verloren gehen.

### Oberfläche

- **Kontextmenüs bleiben sichtbar und zielen auf das richtige Element.** Menüs am rechten Rand werden korrekt vermessen und verschoben. Ein Rechtsklick auf einen Baumknoten hebt jetzt nur das Menüziel hervor, ohne die bestehende Auswahl zu ändern. Gruppenmenüs enthalten außerdem ein Terminal für die jeweilige Gruppe.
- **Übersichtlichere Bearbeitung und Statusbeschriftungen.** Quelltext zeigt für Zeichenfolgen wie HTML-Kommentare keine pfeilförmigen Schriftligaturen mehr an. Nutzungsprozente sind ausdrücklich als verwendet gekennzeichnet, und das unbeteiligte native Kontextmenü des Host-WebView erscheint nicht mehr hinter den VelaTerm-Menüs.

### Fehlerbehebungen

- **Codex bleibt im normalen Terminalverlauf.** Von VelaTerm gestartete Codex-Sitzungen verwenden jetzt den Inline-Terminalmodus. Beim Drücken von Esc zum Unterbrechen oder Zurückgehen werden daher weder die Terminal-Bildschirmpuffer gewechselt noch die Scrollback-Ansicht an den Anfang versetzt. Ihre eigene Codex-Konfiguration bleibt unverändert.
