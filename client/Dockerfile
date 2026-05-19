# 容器化的 DDNS 客户端
# 用法:
#   docker build -t ddns-client .
#   docker run -d --name ddns --restart=always \
#     -e SECRET=xxx \
#     -e WORKER_URL=https://ddns-relay.xxx.workers.dev \
#     ddns-client

FROM alpine:3.19

RUN apk add --no-cache bash curl coreutils tzdata && \
    cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone

COPY ddns-update.sh /usr/local/bin/ddns-update.sh
RUN chmod +x /usr/local/bin/ddns-update.sh

# 把日志输出到 stdout 以便 docker logs 查看
RUN ln -sf /dev/stdout /var/log/ddns.log

# 每 5 分钟运行一次
RUN echo "*/5 * * * * /usr/local/bin/ddns-update.sh" > /etc/crontabs/root

CMD ["crond", "-f", "-d", "8"]
