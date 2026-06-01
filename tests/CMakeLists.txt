add_executable(phase1_validation phase1_validation.cpp)

target_link_libraries(phase1_validation PRIVATE quantcore_core)

target_compile_options(phase1_validation PRIVATE
    -Wall -Wextra
    $<$<CONFIG:Release>:-O2>
)
