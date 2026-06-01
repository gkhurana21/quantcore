find_package(Python3 REQUIRED COMPONENTS Interpreter Development)

# Locate pybind11 via the pip-installed copy
execute_process(
    COMMAND ${Python3_EXECUTABLE} -m pybind11 --cmakedir
    OUTPUT_VARIABLE PYBIND11_CMAKE_DIR
    OUTPUT_STRIP_TRAILING_WHITESPACE
    RESULT_VARIABLE _pybind11_result
)
if(NOT _pybind11_result EQUAL 0)
    message(FATAL_ERROR "pybind11 not found — run: pip install pybind11")
endif()
find_package(pybind11 REQUIRED HINTS "${PYBIND11_CMAKE_DIR}")

pybind11_add_module(quantcore quantcore_py.cpp)
target_link_libraries(quantcore PRIVATE quantcore_core)

# Place the .so next to the Python scripts so `import quantcore` works there
set_target_properties(quantcore PROPERTIES
    LIBRARY_OUTPUT_DIRECTORY "${CMAKE_SOURCE_DIR}/python"
)
