add_library(quantcore_core STATIC
    src/black_scholes.cpp
    src/monte_carlo.cpp
    src/black_scholes_batch.cpp
    src/monte_carlo_mt.cpp
)

target_include_directories(quantcore_core PUBLIC
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
)

target_compile_options(quantcore_core PRIVATE
    -Wall -Wextra -Wpedantic
    $<$<CONFIG:Release>:-O3 -march=native>
    $<$<CONFIG:Debug>:-g -O0>
)

# Apple Accelerate framework — provides vvexp, vvlog, vvsqrt (vForce)
# and vDSP for SIMD-accelerated batch math on Apple Silicon.
if(APPLE)
    target_link_libraries(quantcore_core PUBLIC "-framework Accelerate")
endif()
