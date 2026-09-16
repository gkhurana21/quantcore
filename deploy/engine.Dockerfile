# QuantCore pricing engine: the C++17 core, its pybind11 module and the FastAPI WebSocket server.
#
# Built for Linux containers, so two macOS-only paths compile out: the Metal GPU kernel (the
# OBJCXX language is only enabled on Apple) and the Accelerate vForce/vDSP SIMD calls, which fall
# back to plain loops. -march=native is off because the image is built on one host and run on
# another. The engine therefore serves CPU results only; `info` reports metal: false.
#
# Build and run locally:
#   docker build -f deploy/engine.Dockerfile -t quantcore-engine .
#   docker run --rm -p 8765:8765 -e ALLOWED_ORIGINS=http://localhost:3000 quantcore-engine

FROM python:3.12-slim AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential cmake \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN pip install --no-cache-dir pybind11==2.13.6
COPY CMakeLists.txt ./
COPY core core
COPY bindings bindings
COPY tests tests
RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DQUANTCORE_NATIVE_ARCH=OFF -DQUANTCORE_ACCELERATE=OFF \
 && cmake --build build -j "$(nproc)"
# The acceptance gate runs against the image's own build: a failure here fails the image.
RUN ./build/tests/phase1_validation | tee /tmp/gate.log | tail -5 \
 && ! grep -q "FAIL" /tmp/gate.log

FROM python:3.12-slim
WORKDIR /app
COPY server/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY --from=build /src/python/quantcore*.so /app/python/
COPY server/ws_server.py /app/server/
# HOST binds every interface inside the container; PORT is supplied by the platform (Render sets it).
ENV HOST=0.0.0.0 \
    PORT=8765 \
    PYTHONPATH=/app/python \
    PYTHONUNBUFFERED=1
EXPOSE 8765
CMD ["python", "server/ws_server.py"]
