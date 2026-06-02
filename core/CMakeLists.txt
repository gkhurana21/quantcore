set(CORE_SOURCES
    src/black_scholes.cpp
    src/monte_carlo.cpp
    src/black_scholes_batch.cpp
    src/monte_carlo_mt.cpp
)

if(APPLE)
    list(APPEND CORE_SOURCES src/monte_carlo_gpu.mm)
endif()

add_library(quantcore_core STATIC ${CORE_SOURCES})

target_include_directories(quantcore_core PUBLIC
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
)

target_compile_options(quantcore_core PRIVATE
    -Wall -Wextra -Wpedantic
    $<$<CONFIG:Release>:-O3 -march=native>
    $<$<CONFIG:Debug>:-g -O0>
)

# Apple frameworks
if(APPLE)
    # Accelerate: vvexp/vvlog/vvsqrt (vForce), NEON batch math
    # Metal + Foundation: GPU Monte Carlo kernel
    target_link_libraries(quantcore_core PUBLIC
        "-framework Accelerate"
        "-framework Metal"
        "-framework Foundation")
    # Objective-C ARC for the .mm file
    set_source_files_properties(src/monte_carlo_gpu.mm
        PROPERTIES COMPILE_FLAGS "-fobjc-arc")
endif()
