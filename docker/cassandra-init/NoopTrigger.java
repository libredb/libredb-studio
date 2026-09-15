package probe;
import java.util.Collection;
import java.util.Collections;
import org.apache.cassandra.db.Mutation;
import org.apache.cassandra.db.partitions.Partition;
import org.apache.cassandra.triggers.ITrigger;
public class NoopTrigger implements ITrigger {
  public Collection<Mutation> augment(Partition update) { return Collections.emptyList(); }
}
