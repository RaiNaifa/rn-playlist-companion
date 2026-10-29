// Add release notes for each published version. Keep both languages in sync.
export const RELEASE_NOTES = {
  en: {
    "0.3.0": {
      Added: [
        "Configurable playback boundaries in Sound settings.",
        "Automatic detection of the audio between leading and trailing silence.",
        "The Buffering Threshold world setting sets the duration above which audio is streamed.",
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
    "0.3.0": {
      Добавлено: [
        "Настраиваемые границы воспроизведения в настройках звука.",
        "Автоматический поиск участка звука без тишины в начале и в конце.",
        "Мировая настройка «Порог буферизации» для задания длительности, свыше которой звук воспроизводится потоком.",
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
