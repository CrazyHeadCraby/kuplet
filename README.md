# Куплет

Караоке-кадры для музыкальной викторины. Песни и вопросы остаются в браузере.

Репозиторий: https://github.com/CrazyHeadCraby/kuplet

## Docker

Нужен [Docker Desktop](https://www.docker.com/products/docker-desktop/).

```bash
git clone https://github.com/CrazyHeadCraby/kuplet.git
cd kuplet
docker compose up --build
```

Откройте http://localhost:8080

Остановить: `Ctrl+C`, затем `docker compose down`.

Когда появятся обновления:

```bash
git pull
docker compose up --build
```

Первая сборка скачивает зависимости и занимает несколько минут.

Запись видео — в Chrome или Edge. Ролик пишется в 1280×720, 30 кадров в секунду.
