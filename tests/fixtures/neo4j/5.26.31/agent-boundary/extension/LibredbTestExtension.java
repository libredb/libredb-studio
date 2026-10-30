// A test extension for the agent boundary captures, built by ../run.sh with the image's own JDK and never shipped.
// It is the smallest extension with a side effect: a READ-mode procedure and a user-defined function that each write
// a file into the server's temporary directory, which a READ session runs, so a principal that can execute either
// writes to the server's file system through a read.
package org.libredb.test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.stream.Stream;
import org.neo4j.procedure.Mode;
import org.neo4j.procedure.Procedure;
import org.neo4j.procedure.UserFunction;

public class LibredbTestExtension {
  public static class Written {
    public String path;

    public Written(String path) {
      this.path = path;
    }
  }

  @Procedure(name = "libredbtest.touch", mode = Mode.READ)
  public Stream<Written> touch() throws Exception {
    Path path = Path.of("/tmp/libredbtest-procedure");
    Files.writeString(path, "written by a READ-mode procedure");
    return Stream.of(new Written(path.toString()));
  }

  @UserFunction(name = "libredbtest.touchFn")
  public String touchFn() throws Exception {
    Path path = Path.of("/tmp/libredbtest-function");
    Files.writeString(path, "written by a user-defined function");
    return path.toString();
  }
}
