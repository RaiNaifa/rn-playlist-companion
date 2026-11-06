// Add release notes for each published version. Keep both languages in sync.
export const RELEASE_NOTES = {
  en: {
    "0.4.0": {
      Added: [
        "Import the structure of a selected folder to create playlist folders and playlists with the same nesting and contents.",
        "Play Queue. Add sounds from any playlists to a separate list using a button or drag and drop. Only one playing sound can be linked to the queue at a time.",
        "A separate Player Companion window for controlling current playback, the queue, and volume. Hotkey: P.",
        "Crossfade for smoother transitions between playlist sounds. It uses the standard playlist and sound fade settings when they are set.",
        "A seek bar for any playing or previewed sound. Open it with the button next to the current playback time.",
        "Stop all playing sounds with one click in Currently Playing.",
        "Option to disable looping of the entire playlist in sequential playback mode.",
        "The Launch Controls option in playlist folder settings adds controls to start or stop its playlists together, including those in subfolders.",
        "Personal Silence Time after the previous track for an individual playlist sound.",
        "Playlist background tint in playlist settings.",
        "The “Section header color” client setting.",
        "The “Info color for parameter buttons” client setting.",
        "A new way to create macros by dragging sounds, playlists, or their folders onto the hotbar. The macros let you control playback and see its status directly on the hotbar.",
      ],
      Changed: [
        "Audio ducking during preview is now adjusted in User Volume Controls.",
      ],
    },
    "0.3.2": {
      Added: [
        "Configurable Silence Time between playlist tracks and repeats of a looping sound.",
        "Random playback mode for playlists: each sound is selected at random without repeating the currently playing sound.",
      ],
      Fixed: [
        "Global playlists in Shuffle mode now work the same way as standard Foundry playlists.",
        "Global playlist and folder ownership now changes correctly. Previously damaged permissions are read correctly, and empty folders are hidden from players.",
        "Empty playlist folders now remain visible after creation.",
        "Expanded playlists no longer show an empty area instead of their sound list when their folder is reopened.",
      ],
    },
    "0.3.1": {
      Added: [
        "Ability to collapse the Currently Playing section.",
      ],
      Fixed: [
        'The changelog no longer reappears for the same module version after closing it with "Don\'t show again" checked.',
      ],
    },
    "0.3.0": {
      Added: [
        "Configurable playback boundaries in Sound settings.",
        "Automatic detection of the audio between leading and trailing silence.",
        "The Buffering Threshold world setting sets the duration above which audio is streamed.",
        "The optional Hide Sound Names from Players world setting hides details of playing sounds and their playlists.",
        "The Preserve Playback world setting for applying safe changes without stopping playback.",
        "The optional Disable Revision Checks world setting.",
        "Players can now manage global playlists when they have the required Foundry permissions.",
      ],
      Fixed: [
        "Starting the next Sound in global playlists with sequential playback.",
        "Changing global Sound settings through the interface no longer restarts playback.",
        "Playing global playlist Sounds now appear in Currently Playing.",
        "Global playlist Sounds remain in Currently Playing while paused.",
        "The Preview button in Currently Playing now appears only while a preview is active.",
        "Starting a preview is now blocked for players without ownership of the playlist.",
        "Incorrect error messages.",
      ],
      Changed: [
        "Faster synchronization of global playlist changes between clients.",
        "Deleting global playlists no longer requires updating playback data in every world.",
      ],
    },
  },
  ru: {
    "0.4.0": {
      Добавлено: [
        "Импорт структуры выбранной папки для создания папок и плейлистов такой же вложенности и содержания.",
        "Очередь воспроизведения. Позволяет добавлять (кнопкой или перетаскиванием) звуки из любых плейлистов в отдельный список. Только один воспроизводимый звук одновременно может быть связан с очередью.",
        "Отдельное окно Player Companion для управления текущим воспроизведением, очередью и громкостью. Горячая клавиша - P.",
        "Перекрёстное затухание для плавных переходов между звуками плейлиста. Учитывает стандартные настройки затухания плейлистов и звуков, если они заданы.",
        "Шкала времени для перемотки любого воспроизводимого и предпрослушиваемого звука. Открывается кнопкой рядом с текущим временем воспроизведения.",
        "Возможность остановить одним кликом в «Сейчас играет» все воспроизводимые звуки.",
        "Возможность отключить повторение всего плейлиста для режима последовательного воспроизведения.",
        "Опция «Управление запуском» в настройках папки плейлиста позволяет добавить ей элементы управления вложенными плейлистами для их одновременного запуска или остановки (включая подпапки).",
        "Личное «Время тишины» после предыдущего трека для звука плейлиста.",
        "Настройка оттенка фона плейлиста в его параметрах.",
        "Клиентская настройка «Цвет заголовков разделов».",
        "Клиентская настройка «Инфо-цвет для кнопок параметров».",
        "Новый способ создания макросов при перетаскивании звуков, плейлистов и их папок на панель быстрого доступа: позволяет управлять их воспроизведением и отслеживать статус воспроизведения прямо из панели быстрого доступа.",
      ],
      Изменено: [
        "Приглушение аудио во время предпрослушивания теперь настраивается в Управлении громкостью.",
      ],
    },
    "0.3.2": {
      Добавлено: [
        "Настраиваемое «Время тишины» между треками плейлиста и повторами зацикленного звука.",
        "Режим воспроизведения «Случайный» для плейлистов: каждый включаемый звук выбирается случайно, не повторяя при этом текущий.",
      ],
      Исправлено: [
        "Глобальные плейлисты в режиме «Перемешивание» теперь работают так же как стандартные плейлисты Foundry.",
        "Владение глобальными плейлистами и папками теперь изменяется корректно. Ранее повреждённые права читаются правильно, а пустые папки скрыты от игроков.",
        "Пустые папки плейлистов теперь остаются видимыми после создания.",
        "Развёрнутые плейлисты после повторного открытия папки больше не отображают пустоту вместо списка звуков.",
      ],
    },
    "0.3.1": {
      Добавлено: [
        "Возможность свернуть вкладку «Сейчас играет».",
      ],
      Исправлено: [
        "Теперь окно изменений не отображается снова для той же версии модуля, если было закрыто с отмеченным чекбоксом «Больше не показывать»",
      ],
    },
    "0.3.0": {
      Добавлено: [
        "Настраиваемые границы воспроизведения в настройках звука.",
        "Автоматический поиск участка звука без тишины в начале и в конце.",
        "Мировая настройка «Порог буферизации» для задания длительности, свыше которой звук воспроизводится потоком.",
        "Необязательная мировая настройка «Скрывать имена звуков от игроков» для скрытия деталей воспроизводимых звуков и их плейлистов.",
        "Мировая настройка «Сохранение воспроизведения» для применения безопасных изменений без остановки воспроизведения.",
        "Необязательная мировая настройка «Отключение проверок ревизии».",
        "Игроки теперь могут управлять глобальными плейлистами при наличии разрешений Foundry.",
      ],
      Исправлено: [
        "Запуск следующего звука в глобальных плейлистах с последовательным воспроизведением.",
        "Изменение параметров глобального звука через интерфейс больше не перезапускает его воспроизведение.",
        "Отображение играющих звуков глобальных плейлистов в «Сейчас играет».",
        "Отображение звука глобального плейлиста в «Сейчас играет» во время паузы.",
        "Кнопка предпрослушивания в «Сейчас играет» теперь видна только при включённом предпрослушивании.",
        "Запуск предпрослушивания теперь заблокирован у игроков без владения плейлистом.",
        "Исправлены некорректные сообщения об ошибках.",
      ],
      Изменено: [
        "Ускорена синхронизация изменений глобальных плейлистов между клиентами.",
        "Удаление глобальных плейлистов больше не требует обновления данных воспроизведения во всех мирах.",
      ],
    },
  },
};
