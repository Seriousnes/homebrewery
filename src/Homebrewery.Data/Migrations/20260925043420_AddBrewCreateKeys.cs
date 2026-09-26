using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Homebrewery.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddBrewCreateKeys : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "brew_create_keys",
                columns: table => new
                {
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    key = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    brew_id = table.Column<Guid>(type: "uuid", nullable: false),
                    request_hash = table.Column<byte[]>(type: "bytea", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_brew_create_keys", x => new { x.user_id, x.key });
                    table.ForeignKey(
                        name: "fk_brew_create_keys_asp_net_users_user_id",
                        column: x => x.user_id,
                        principalTable: "asp_net_users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_brew_create_keys_brews_brew_id",
                        column: x => x.brew_id,
                        principalTable: "brews",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_brew_create_keys_brew_id",
                table: "brew_create_keys",
                column: "brew_id");

            migrationBuilder.CreateIndex(
                name: "ix_brew_create_keys_created_at",
                table: "brew_create_keys",
                column: "created_at");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "brew_create_keys");
        }
    }
}
