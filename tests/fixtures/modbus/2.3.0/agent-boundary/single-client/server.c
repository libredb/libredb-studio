/*
 * A Modbus TCP device that serves one client at a time, the way a libmodbus server written to its
 * documented single-connection pattern does (modbus_tcp_listen with a backlog of one, then
 * modbus_tcp_accept, then receive and reply until the client goes, then accept the next): while one
 * client holds its connection, a second waits in the backlog unanswered.
 *
 * It exists only for the agent boundary capture (run.sh beside the parent directory), which measures
 * how long a second client is locked out by a read and how soon it is answered once that read
 * closes. Its tables carry the same values as docker/modbus/modbus_server.json, so a read that
 * answers here answers what the pinned fixture answers.
 */
#include <modbus.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

int main(void) {
  modbus_t *ctx = modbus_new_tcp("0.0.0.0", 502);
  modbus_mapping_t *map = modbus_mapping_new(10, 8, 10, 8);
  if (ctx == NULL || map == NULL) return 1;
  for (int n = 0; n < 10; n++) {
    map->tab_registers[n] = (uint16_t)(7000 + 11 * n);
    map->tab_bits[n] = (n % 3 == 0);
  }
  for (int n = 0; n < 8; n++) {
    map->tab_input_registers[n] = (uint16_t)(8500 - 7 * n);
    map->tab_input_bits[n] = (n == 2 || n == 3 || n == 5 || n == 7);
  }
  int server = modbus_tcp_listen(ctx, 1);
  if (server == -1) return 1;
  setvbuf(stdout, NULL, _IONBF, 0);
  printf("listening\n");
  for (;;) {
    if (modbus_tcp_accept(ctx, &server) == -1) continue;
    uint8_t query[MODBUS_TCP_MAX_ADU_LENGTH];
    for (;;) {
      int rc = modbus_receive(ctx, query);
      if (rc > 0) modbus_reply(ctx, query, rc, map);
      else if (rc == -1) break;
    }
    close(modbus_get_socket(ctx));
  }
}
