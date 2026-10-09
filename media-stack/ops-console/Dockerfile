# Console d'ops : stdlib Python seulement, aucune dependance a installer.
FROM python:3.13-alpine
COPY server.py /app/server.py
COPY static /app/static
WORKDIR /app
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD python3 -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8080/health',timeout=4)"
CMD ["python3", "/app/server.py"]
