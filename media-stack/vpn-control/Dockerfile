FROM docker:27-cli
RUN apk add --no-cache python3 docker-cli-compose
COPY server.py /server.py
WORKDIR /srv/media-stack
EXPOSE 8080
CMD ["python3", "/server.py"]
