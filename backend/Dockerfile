FROM python:3.11-slim

# ffmpeg = motor de vídeo/áudio; fontes = texto dentro do vídeo (drawtext).
# Pacotes extras dão fontes DISTINTAS para cada estilo curado no Linux:
#   fonts-urw-base35        -> NimbusSansNarrow (impacto) / NimbusSans (moderna) / NimbusMonoPS (maquina)
#   fonts-crosextra-carlito -> Carlito (moderna, estilo Verdana)
#   fonts-comic-neue        -> Comic Neue (manuscrita, substituta aberta da Comic Sans)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    fonts-liberation \
    fonts-dejavu-core \
    fonts-noto-color-emoji \
    fonts-urw-base35 \
    fonts-crosextra-carlito \
    fonts-comic-neue \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# Onde as mídias e vídeos gerados ficam (montado como volume no compose).
ENV STORAGE_DIR=/app/storage
EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
