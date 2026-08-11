## v0.1.100 — 2026-08-10

### Agentes de IA

- **Kiro CLI pasa a ser un tipo de sesión de primera clase.** Las sesiones de Kiro tienen su propio nodo en el árbol, un indicador de estado autoritativo de «trabajando» o «en espera» que se apoya en los propios lifecycle hooks de Kiro, notificaciones al terminar un turno, reanudación automática de la misma conversación al volver a abrir el nodo, argumentos de inicio y una opción para omitir confirmaciones, además del lanzamiento mediante vspawn: todo lo que los demás agentes ya tenían. VelaTerm clona tu agente Kiro predeterminado en un agente `vlx-term` propio, añade a esa copia lifecycle hooks de solo observación y lanza esa copia; tu archivo de agente no se modifica nunca, y tu prompt, tus herramientas y tus servidores MCP se conservan sin cambios. Kiro no tiene ningún hook de solicitud de permisos, por lo que el indicador se mantiene en «trabajando» mientras espera tu aprobación.

### Correcciones

- **Los programas iniciados desde el terminal ya no heredan el entorno propio del AppImage (Linux).** El lanzador del AppImage apunta `PYTHONHOME`, `PYTHONPATH`, `PERLLIB`, `QT_PLUGIN_PATH` y las rutas de plugins de GStreamer al directorio de montaje temporal del paquete, y coloca los directorios del paquete por delante de todo lo demás en `PATH` y `LD_LIBRARY_PATH`. Un terminal entrega todo su entorno al shell que inicia, así que el `python3` del sistema buscaba su biblioteca estándar dentro del paquete y se negaba a arrancar, y otros programas enlazados dinámicamente cargaban la copia de una biblioteca incluida en el paquete en lugar de la del sistema. Ahora VelaTerm elimina esas rutas del paquete antes de iniciar un shell o una herramienta externa, y no toca los valores que hayas definido tú. `APPDIR` y `APPIMAGE` siguen visibles, de modo que los programas que comprueban si se están ejecutando desde un AppImage siguen obteniendo su respuesta. Solo afectaba a las compilaciones AppImage; el paquete deb, macOS y Windows se comportan igual que antes.

## v0.1.99 — 2026-08-09

### Terminal

- **Shift+Intro escribe un salto de línea en lugar de enviar.** Los terminales no tienen codificación para Intro con una tecla modificadora, así que las CLI de agentes como Claude Code y Codex solo recibían un retorno de carro normal y enviaban el mensaje cuando aún se estaba escribiendo. Ahora VelaTerm emite ESC+CR, la misma secuencia que esas herramientas esperan de una asignación de teclas de iTerm2, de modo que la entrada de varias líneas ya funciona, también en macOS, donde el manejador de teclas personalizado ni siquiera se instalaba. La composición en un método de entrada no se altera: Intro sigue confirmando el candidato.

### Proyectos y organización

- **Actualizar el estado de una sola sesión.** En un panel con filtro de estado, las sesiones incorporan la acción «Actualizar estado», que reevalúa únicamente esa sesión según las condiciones del propio panel y la añade o la quita mientras las demás permanecen en su sitio. La acción pertenece al panel desde el que se abrió el menú, por lo que las divisiones anidadas nunca toman prestado el filtro de otro panel. El resultado se guarda por panel y se restaura tras reiniciar.
- **Quitar una marca cuesta un clic.** Elegir el emoji ya aplicado lo elimina, así que la entrada específica para quitarlo y su separador desaparecen. La insignia de emoji del botón de filtro también se retira: el resaltado ya indica que hay un filtro de marca activo y el menú indica cuál es.

### Correcciones

- **La integración de escritorio del AppImage de Linux se instala en cualquier equipo.** El icono incluido era un enlace simbólico a una ruta absoluta de la máquina de compilación, por lo que herramientas como Gear Lever y AppImageLauncher no podían extraerlo, aunque la aplicación funcionara con normalidad. Ahora el enlace es relativo. También se corrigió el requisito de glibc a 2.35 tras medir las bibliotecas incluidas y no solo el ejecutable, lo que convierte a Ubuntu 22.04 en la distribución más antigua compatible con la aplicación de escritorio.

## v0.1.98 — 2026-08-02

### Agentes de IA

- **Grok Build se incorpora a VelaTerm como agente de primera clase.** Instala, inicia y reanuda Grok 4.5 con identificadores de sesión estables, lifecycle hooks oficiales, estados precisos de trabajo y permisos, transcripciones unificadas, detalles de uso y un icono oficial que se adapta al tema en las vistas de escritorio, navegador y móvil.

### Proyectos y organización

- **Divide la barra lateral de proyectos en vistas de trabajo independientes.** Cualquier panel del árbol puede volver a dividirse hacia abajo y recupera tras reiniciar su propia búsqueda, filtros de estado y emoji, estado de plegado y proporción de tamaño. Todos los paneles siguen siendo proyecciones del mismo árbol de proyectos gestionado por el backend, por lo que los cambios se sincronizan sin duplicar datos de negocio.
- **Marca y filtra nodos sin perder el contexto.** Los proyectos, grupos y sesiones pueden llevar marcadores emoji. Un contenedor marcado conserva todo su subárbol, la pertenencia a estados permanece estable mientras trabajas, están disponibles tanto la incorporación dinámica como la actualización manual, y las condiciones de estado y emoji se combinan como una unión.
- **Crea un proyecto vacío al instante.** Elige el directorio superior, valida el nombre y crea e importa la carpeta en un único flujo. Si se produce un fallo parcial, solo se reintenta la importación, sin crear directorios duplicados.

### Interfaz

- **Comparte VelaTerm donde esté tu comunidad.** El diálogo de compartir ahora incluye WeChat Moments, Weibo, Xiaohongshu, X, Reddit, Hacker News, LinkedIn, Facebook, Telegram y WhatsApp, con un flujo de código QR para WeChat y una invitación a compartir en el diálogo de actualización.
- **Interacciones pequeñas, pero más cuidadas.** Las pestañas de terminal temporales se pueden renombrar antes de convertirse en sesiones guardadas. Los campos de entrada normales desactivan las mayúsculas automáticas de los teclados móviles sin alterar la entrada del terminal.

## v0.1.97 — 2026-07-25

### Agentes de IA

- **Las sesiones ya no se quedan atascadas en «trabajando».** Codex informaba de la actividad de herramientas y del fin de turno mediante procesos efímeros distintos, cuyos callbacks podían llegar desordenados y dejar un turno terminado mostrado como aún en curso. Ahora se descartan los informes intermedios que llegan después del final de su propio turno, y un nuevo enlace de fin de sesión cubre las sesiones que terminan sin evento de finalización.
- **Los turnos interrumpidos se resuelven en segundos.** Pulsar Esc, o un error de flujo, termina un turno de Claude o Codex sin ningún callback de finalización. Seis segundos de silencio en el terminal corrigen ahora esa sesión a en espera de forma discreta, sin lanzar una notificación de «ha respondido».

### Interfaz

- **Atajos de división fiables en macOS.** Dividir a la derecha (Cmd+D) y dividir hacia abajo (Cmd+Shift+D) se registran ahora como comandos del menú Terminal nativo, de modo que macOS ya no intercepta la combinación antes que VelaTerm.
- **Un guardado por pulsación.** Cmd+S se procesaba tanto en el atajo global como en el editor enfocado, lo que podía escribir el mismo archivo dos veces en una sola pulsación.

## v0.1.96 — 2026-07-23

### Agentes de IA

- **El estado de Codex confía en lifecycle hooks, no en suposiciones del terminal.** Las sesiones modernas de Codex usan únicamente los lifecycle hooks oficiales como fuente de actividad. Un enlace `SessionStart` verifica la integración, la ausencia de callbacks se muestra como «Estado no disponible» y el texto o la actividad del terminal ya no puede sobrescribir los estados de trabajo, confirmación o finalización.
- **Uso de Codex más actualizado tras cada turno.** El panel Info muestra de inmediato el snapshot rollout local, lo concilia con los límites en vivo, vuelve a actualizar después de que Codex escriba el snapshot token final e ignora respuestas tardías de una sesión anterior.

### Interfaz

- **Selección fiable en el árbol de proyectos de macOS.** Las filas virtuales ya no dependen de transform del compositor, lo que evita que coordenadas de hit-test obsoletas de WKWebView envíen acciones de pasar el cursor, hacer clic o arrastrar a otra fila después de desplazarse o actualizar el árbol.

## v0.1.95 — 2026-07-21

### Agentes de IA

- **Kimi Code y Zoo Code llegan al árbol de sesiones.** VelaTerm ya puede iniciar, reanudar, instalar y configurar ambos agentes. Kimi usa sus lifecycle hooks oficiales para informar de forma autoritativa los estados de trabajo, permiso y espera; Zoo Code conserva una identidad de tarea estable y usa detección del terminal cuando no hay hooks externos.
- **Actualización en vivo del uso de Codex.** El panel Info consulta el Codex app server para obtener los límites actuales y mantiene la instantánea rollout local como alternativa compatible.

### Proyectos y terminales

- **Abre proyectos con `vela <path>`.** Las versiones empaquetadas pueden instalar un comando shell al estilo de VS Code. Una segunda llamada envía el proyecto a la ventana VelaTerm existente en lugar de abrir una instancia duplicada.
- **Clonado Git visible y cancelable.** Clone Project muestra etapas, porcentaje y tiempo transcurrido, avisa si el progreso se detiene y puede cancelar todo el árbol de procesos Git sin dejar un destino incompleto. Las credenciales y query tokens se ocultan en errores y registros de auditoría.
- **Terminales WSL en Windows.** Todas las distribuciones WSL instaladas se ofrecen junto a PowerShell, cmd y Git Bash para terminales normales. Los agentes siguen usando el shell anfitrión de Windows para mantener fiables los hooks y las rutas de ejecutables.

### Interfaz y fiabilidad

- **Control más claro de sesiones en segundo plano.** Los menús muestran el estado en vivo de cada sesión y el diálogo de límite permite cerrar varias pestañas seleccionadas a la vez.
- **Ciclo de vida más seguro y notas multilingües.** Se confirma antes de detener sesiones activas; la identidad lifecycle exacta de Codex prevalece sobre análisis rollout ambiguos; las notas de actualización admiten todos los idiomas incluidos.

## v0.1.94 — 2026-07-12

### Localización

- **Interfaz en vietnamita.** Tiếng Việt ya está disponible en el selector de idiomas y se selecciona automáticamente cuando el sistema usa una configuración regional vietnamita.

### Navegador

- **Inicio más rápido del navegador integrado.** Cada pestaña del navegador dispone ahora de accesos directos de un clic para ChatGPT, Claude, Gemini y Google. Los menús contextuales de proyectos y grupos también permiten crear una página permanente del navegador directamente en la parte correspondiente del árbol de sesiones.

### Imágenes y documentos

- **Pegado fiable de rutas de imagen en macOS.** Cuando WebKit no expone una imagen copiada como archivo, VelaTerm la lee ahora del portapapeles nativo y la sigue subiendo como ruta de archivo, en lugar de recurrir silenciosamente al marcador de imagen nativo del agente. Las ventanas remotas siempre muestran el ajuste de pegado de imágenes, explican por qué se requiere el modo de ruta de archivo y desactivan la opción nativa no disponible.
- **Pegado de imágenes en documentos fuente.** El editor de código fuente acepta ahora imágenes del portapapeles. Los documentos Markdown guardados las almacenan junto al documento en `assets/` e insertan una sintaxis de imagen Markdown portable; los borradores sin guardar incrustan los datos de la imagen para que no se pierdan al limpiar los archivos temporales.

### Interfaz

- **Los menús contextuales permanecen visibles y apuntan al elemento correcto.** Los menús abiertos cerca del borde derecho se miden y desplazan correctamente. Al hacer clic con el botón derecho en un nodo del árbol, ahora solo se resalta el objetivo del menú sin cambiar la selección existente; los menús de grupo también incluyen un terminal limitado a ese grupo.
- **Edición y etiquetas de estado más limpias.** El texto fuente ya no representa ligaduras tipográficas en forma de flecha para secuencias como comentarios HTML, los porcentajes de uso se etiquetan explícitamente como utilizados y el menú contextual nativo no relacionado del WebView anfitrión ya no aparece detrás de los menús de VelaTerm.

### Correcciones

- **Codex permanece en el historial normal del terminal.** Las sesiones de Codex iniciadas por VelaTerm ahora utilizan el modo de terminal en línea. Por tanto, pulsar Esc para interrumpir o retroceder ya no cambia los búferes de pantalla del terminal ni desplaza la vista del historial hasta arriba. La configuración de Codex del usuario no se modifica.
