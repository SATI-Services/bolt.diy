FROM node:20-bookworm

# ============================================================
# Full-stack sidecar: supports JS, PHP, Python, Ruby, Go, Rust,
# Java, .NET, C/C++, and common dev tools.
# ============================================================

ENV DEBIAN_FRONTEND=noninteractive

# Core build tools and utilities
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    wget \
    git \
    unzip \
    zip \
    ca-certificates \
    gnupg \
    lsb-release \
    software-properties-common \
    pkg-config \
    libssl-dev \
    libffi-dev \
    zlib1g-dev \
    libbz2-dev \
    libreadline-dev \
    libsqlite3-dev \
    libncurses-dev \
    libxml2-dev \
    libcurl4-openssl-dev \
    libonig-dev \
    libzip-dev \
    libpng-dev \
    libjpeg-dev \
    libfreetype-dev \
    libpq-dev \
    default-libmysqlclient-dev \
    && rm -rf /var/lib/apt/lists/*

# ---- PHP 8.3 + Composer ----
RUN curl -sSL https://packages.sury.org/php/README.txt | bash -x 2>/dev/null || true \
    && apt-get update && apt-get install -y --no-install-recommends \
    php8.3 \
    php8.3-cli \
    php8.3-common \
    php8.3-curl \
    php8.3-mbstring \
    php8.3-xml \
    php8.3-zip \
    php8.3-bcmath \
    php8.3-gd \
    php8.3-mysql \
    php8.3-pgsql \
    php8.3-sqlite3 \
    php8.3-tokenizer \
    php8.3-intl \
    php8.3-readline \
    && rm -rf /var/lib/apt/lists/* \
    && curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer

# ---- Python 3.12 + pip ----
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    python3-dev \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m pip install --break-system-packages --no-cache-dir \
    pipenv \
    poetry \
    virtualenv

# ---- Ruby 3.x + Bundler ----
RUN apt-get update && apt-get install -y --no-install-recommends \
    ruby-full \
    && rm -rf /var/lib/apt/lists/* \
    && gem install bundler

# ---- Go (latest stable) ----
RUN GOVERSION=$(curl -sL 'https://go.dev/VERSION?m=text' | head -1) \
    && curl -sLO "https://go.dev/dl/${GOVERSION}.linux-amd64.tar.gz" \
    && tar -C /usr/local -xzf "${GOVERSION}.linux-amd64.tar.gz" \
    && rm "${GOVERSION}.linux-amd64.tar.gz"
ENV PATH="/usr/local/go/bin:/root/go/bin:${PATH}"

# ---- Rust (via rustup) ----
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}"

# ---- Java 21 (Eclipse Temurin) + Maven + Gradle ----
RUN curl -sL https://packages.adoptium.net/artifactory/api/gpg/key/public | gpg --dearmor -o /usr/share/keyrings/adoptium.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/adoptium.gpg] https://packages.adoptium.net/artifactory/deb $(lsb_release -cs) main" > /etc/apt/sources.list.d/adoptium.list \
    && apt-get update && apt-get install -y --no-install-recommends temurin-21-jdk \
    && rm -rf /var/lib/apt/lists/*
RUN MAVEN_VERSION=3.9.9 \
    && curl -sLO "https://archive.apache.org/dist/maven/maven-3/${MAVEN_VERSION}/binaries/apache-maven-${MAVEN_VERSION}-bin.tar.gz" \
    && tar -C /opt -xzf "apache-maven-${MAVEN_VERSION}-bin.tar.gz" \
    && ln -s "/opt/apache-maven-${MAVEN_VERSION}/bin/mvn" /usr/local/bin/mvn \
    && rm "apache-maven-${MAVEN_VERSION}-bin.tar.gz"
RUN GRADLE_VERSION=8.12 \
    && curl -sLO "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip" \
    && unzip -q -d /opt "gradle-${GRADLE_VERSION}-bin.zip" \
    && ln -s "/opt/gradle-${GRADLE_VERSION}/bin/gradle" /usr/local/bin/gradle \
    && rm "gradle-${GRADLE_VERSION}-bin.zip"

# ---- .NET 8 SDK ----
RUN curl -sL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 8.0 --install-dir /usr/share/dotnet \
    && ln -s /usr/share/dotnet/dotnet /usr/local/bin/dotnet
ENV DOTNET_ROOT="/usr/share/dotnet"

# ---- Elixir + Erlang ----
RUN apt-get update && apt-get install -y --no-install-recommends \
    erlang \
    elixir \
    && rm -rf /var/lib/apt/lists/*

# ---- Database CLIs ----
RUN apt-get update && apt-get install -y --no-install-recommends \
    sqlite3 \
    default-mysql-client \
    postgresql-client \
    redis-tools \
    && rm -rf /var/lib/apt/lists/*

# ---- Node.js global tools ----
RUN npm install -g ws pnpm yarn typescript tsx vite \
    && curl -fsSL https://bun.sh/install | bash \
    && ln -sf /root/.bun/bin/bun /usr/local/bin/bun

# ---- Sidecar server ----
WORKDIR /app

COPY server.mjs /sidecar/server.mjs

EXPOSE 3000 9838

ENV SIDECAR_TOKEN=""

CMD ["node", "/sidecar/server.mjs"]
