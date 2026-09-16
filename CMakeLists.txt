cmake_minimum_required(VERSION 3.21)
project(QuantCore VERSION 0.1.0 LANGUAGES CXX)

# The Metal kernel is Objective-C++ and only builds on Apple platforms; enabling the language
# elsewhere fails configuration outright (no Objective-C++ compiler on Linux).
if(APPLE)
    enable_language(OBJCXX)
endif()

# Tuning for the building machine. Off for containers, where the image is built on one host and
# run on another and -march=native can emit instructions the runtime CPU does not have.
option(QUANTCORE_NATIVE_ARCH "Tune the build for the building machine (-march=native)" ON)
# Apple Accelerate (vForce/vDSP) SIMD in the batch and multithreaded kernels; the portable
# fallbacks are plain loops the compiler vectorises.
option(QUANTCORE_ACCELERATE "Use Apple Accelerate SIMD where available" ${APPLE})

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
endif()

if(APPLE AND CMAKE_SYSTEM_PROCESSOR STREQUAL "arm64")
    message(STATUS "QuantCore: Apple Silicon (arm64)")
endif()

add_subdirectory(core)
add_subdirectory(tests)
add_subdirectory(bindings)
